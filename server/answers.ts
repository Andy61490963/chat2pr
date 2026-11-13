import type { Database, DbClient } from "./db.js";
import { AppError, classifyRisk, queryRisk, redact } from "./policy.js";
import { notifyGroup } from "./group-replies.js";
import { approvalNotice, saveProjectConfirmation } from "./project-routing.js";
import { withAssumptions } from "../shared/clarification.js";
import type { Task } from "../shared/types.js";
import { asksForSchedule, parseSchedule } from "../shared/checks.js";
import { assertContextText } from "./project-context.js";

/**
 * 補問在原地回答：在提出需求的群組發問，成員用 LINE「回覆」或在看板直接作答，
 * 系統把回答併進需求成為新版本。查詢符合自動執行條件就直接繼續；修改照舊等管理者確認。
 */

const questionKey = (t: Pick<Task, "id" | "version">) =>
  `question:${t.id}:${t.version}`;

/** 在群組發出補問；群組設定不回覆時不發，仍由管理者私訊與看板處理。 */
export async function askInGroup(c: DbClient, t: Task) {
  if (!t.question) return;
  const choices = t.question.choices.length
    ? `\n常見答案：${t.question.choices.join("／")}`
    : "";
  await notifyGroup(
    c,
    t.id,
    "question",
    questionKey(t),
    `想跟你確認一件事（${t.title}）：\n${t.question.text}${choices}\n直接「回覆」這則訊息回答就可以。`,
    "results",
  );
}

/** 成員引用的是這一版需求的補問，且需求仍在等回答時，回傳該任務（已鎖定）。 */
export async function questionByQuote(
  c: DbClient,
  groupId: string,
  quotedId: string,
) {
  return (
    await c.query<Task>(
      `SELECT t.* FROM notifications n JOIN tasks t ON t.id=n.task_id
       WHERE n.sent_message_id=$1 AND n.group_id=$2 AND t.group_id=$2 AND n.kind='group_question'
       AND t.status='awaiting_approval' AND t.question IS NOT NULL
       AND n.dedupe_key='group:question:'||t.id||':'||t.version
       FOR UPDATE OF t`,
      [quotedId, groupId],
    )
  ).rows[0];
}

/**
 * 把回答併進需求：摘要加上「補充／回答」，清掉已回答的問題，產生新版本。
 * byMember：在看板由登入成員作答，視同確認專案；LINE 回答只在原本專案已明確時沿用。
 */
export async function applyAnswer(
  db: Database,
  c: DbClient,
  task: Task,
  answer: string,
  actor: string,
  byMember = false,
  sourceId?: string,
) {
  const question = task.question;
  if (!question) throw new AppError(409, "這個需求目前沒有待回答的問題");
  const text = answer.trim();
  if (!text) throw new AppError(422, "請輸入回答");
  if (text.length > 2000)
    throw new AppError(422, "回答請在 2,000 字內，較長的內容請改用補充需求");
  const assumptions = task.assumptions ?? [];
  const body = withAssumptions(task.summary, [], assumptions);
  const summary = withAssumptions(
    `${body}\n\n補充：${question.text}\n回答：${redact(text)}`,
    assumptions,
  );
  const missing = task.missing.filter((m) => !question.text.includes(m));
  const risk = task.mode === "query" ? queryRisk(text) : classifyRisk(text, []);
  const risks = [...new Set([...task.risk_reasons, ...(risk ? [risk] : [])])];
  // 判讀先問了「多久檢查一次」：回答讀得出排程就記下來，這一題才會擬出定期檢查，而不是只回答一份方案。
  const schedule =
    task.mode === "query" && !task.check_draft && asksForSchedule(question.text)
      ? parseSchedule(text)
      : null;
  const auto =
    task.mode === "query" &&
    !missing.length &&
    !risks.length &&
    !!task.project_id &&
    !!task.target_branch &&
    (byMember || task.project_routing?.status === "clear");
  const t = (
    await c.query<Task>(
      `UPDATE tasks SET summary=$3,missing=$4,risk_reasons=$5,question=NULL,suggestions='[]',version=version+1,
         approved_version=CASE WHEN $6 THEN version+1 ELSE NULL END,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,
         status=CASE WHEN $6 THEN 'queued' ELSE 'awaiting_approval' END,last_error=NULL,updated_at=now(),
         source_ids=CASE WHEN $7::text IS NULL THEN source_ids ELSE array_append(source_ids,$7) END,
         check_draft=COALESCE($8::jsonb,check_draft)
       WHERE id=$1 AND version=$2 AND status='awaiting_approval' RETURNING *`,
      [
        task.id,
        task.version,
        summary,
        JSON.stringify(missing),
        JSON.stringify(risks),
        auto,
        sourceId ?? null,
        schedule ? JSON.stringify(schedule) : null,
      ],
    )
  ).rows[0];
  if (!t) throw new AppError(409, "需求已經更新，請重新整理後再回答");
  await c.query(
    "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [
      t.id,
      t.version,
      t.summary,
      JSON.stringify(t.acceptance),
      auto ? actor : null,
    ],
  );
  await db.audit(
    t.id,
    "question_answered",
    `${actor} 回答「${question.text.slice(0, 200)}」：${redact(text).slice(0, 500)}${auto ? "，已自動繼續查詢" : "，等待確認"}`,
    c,
  );
  if (auto)
    await saveProjectConfirmation(
      c,
      t,
      byMember ? "manual" : "evidence",
      byMember ? actor : "延續已確認的專案",
    );
  else await approvalNotice(c, t);
  return t;
}

/** 看板作答：鎖定任務、核對版本後套用。 */
export async function answerFromDashboard(
  db: Database,
  taskId: string,
  version: number,
  answer: string,
  actor: string,
) {
  return db.transaction(async (c) => {
    const t = (
      await c.query<Task>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [
        taskId,
      ])
    ).rows[0];
    if (!t) throw new AppError(404, "找不到任務");
    if (t.version !== version)
      throw new AppError(409, "需求已經更新，請重新整理後再回答");
    if (t.status !== "awaiting_approval" || !t.question)
      throw new AppError(409, "這個需求目前沒有待回答的問題");
    assertContextText(answer);
    const updated = await applyAnswer(db, c, t, answer, actor, true);
    return { id: updated.id, status: updated.status };
  });
}
