import type { Database, DbClient } from "./db.js";
import {
  AppError,
  classifyRisk,
  containsCredential,
  queryRisk,
  redact,
} from "./policy.js";
import { notifyGroup, type QuickReply } from "./group-replies.js";
import { approvalNotice, saveProjectConfirmation } from "./project-routing.js";
import { withAssumptions } from "../shared/clarification.js";
import type { Task } from "../shared/types.js";
import { asksForSchedule, parseSchedule } from "../shared/checks.js";
import { assertContextText } from "./project-context.js";

/**
 * 補問在原地回答：在提出需求的群組發問，成員用「回覆」或在看板直接作答，
 * 系統把回答併進需求成為新版本。查詢符合自動執行條件就直接繼續；修改照舊等管理者確認。
 */

const questionKey = (t: Pick<Task, "id" | "version">) =>
  `question:${t.id}:${t.version}`;

/**
 * 常見答案按鈕的 postback data：`answer:<taskId>:<version>:<index>`。
 * LINE 回傳資料與 Discord 按鈕使用同一個格式與版本比對。
 */
export const answerPostbackData = (
  t: Pick<Task, "id" | "version">,
  index: number,
) => `answer:${t.id}:${t.version}:${index}`;
/** 解析常見答案按鈕的 postback data；索引只有一位數（常見答案最多三個）。 */
export const answerPostback =
  /^answer:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d)$/;

/** LINE 快速回覆按鈕：標籤最多 20 字，按下後以使用者身分顯示的文字最多 300 字。 */
const chars = (s: string, max: number) => Array.from(s).slice(0, max).join("");

/**
 * 每個常見答案一個按鈕。空白或含憑證格式的選項不給按鈕（ingest 也不會收），
 * 索引沿用 question.choices 的位置，作答時以任務上的選項原文為準，不信任按鈕帶來的文字。
 */
export function questionButtons(t: Task): QuickReply[] {
  return (t.question?.choices ?? []).flatMap((choice, i) =>
    i <= 9 && choice.trim() && !containsCredential(choice)
      ? [
          {
            label: chars(choice.trim(), 20),
            data: answerPostbackData(t, i),
            displayText: chars(choice, 300),
          },
        ]
      : [],
  );
}

/** 在群組發出補問；群組設定不回覆時不發，仍由管理者私訊與看板處理。 */
export async function askInGroup(c: DbClient, t: Task) {
  if (!t.question) return;
  const buttons = questionButtons(t);
  const choices = buttons.length
    ? `\n常見答案：${buttons.map((b) => b.displayText).join("／")}`
    : "";
  // LINE 的按鈕可能被新訊息收起，兩個平台都提供直接回覆的作答方式。
  const how = buttons.length
    ? "點下方的常見答案，也可以直接「回覆」這則訊息回答。"
    : "直接「回覆」這則訊息回答就可以。";
  await notifyGroup(
    c,
    t.id,
    "question",
    questionKey(t),
    `想跟你確認一件事（${t.title}）：\n${t.question.text}${choices}\n${how}`,
    "results",
    buttons,
  );
}

/**
 * 群組成員點了常見答案按鈕（呼叫端已鎖定群組設定、確認群組啟用）。
 * 鎖定任務並核對：同群組、版本與按鈕相同、仍在等回答、選項存在且不含憑證格式；
 * 全部符合才以任務上的選項原文作答，權限與用「回覆」作答相同（修改仍等管理者確認）。
 * 回傳更新後的任務；不符合時回傳 null。
 */
export async function answerByPostback(
  db: Database,
  c: DbClient,
  groupId: string,
  data: string,
  eventId: string,
  actor = "群組成員（LINE）",
) {
  const m = answerPostback.exec(data);
  if (!m) return null;
  const t = (
    await c.query<Task>(
      "SELECT * FROM tasks WHERE id=$1 AND group_id=$2 FOR UPDATE",
      [m[1], groupId],
    )
  ).rows[0];
  const choice = t?.question?.choices[Number(m[3])];
  if (
    !t ||
    t.version !== Number(m[2]) ||
    t.status !== "awaiting_approval" ||
    !choice?.trim() ||
    containsCredential(choice)
  )
    return null;
  return applyAnswer(
    db,
    c,
    t,
    choice,
    actor,
    false,
    `postback:${eventId}`,
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
  assertContextText(text);
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
    const updated = await applyAnswer(db, c, t, answer, actor, true);
    return { id: updated.id, status: updated.status };
  });
}
