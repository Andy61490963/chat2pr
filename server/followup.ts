import { randomUUID } from "node:crypto";
import type { Database, DbClient } from "./db.js";
import { AppError, queryRisk, redact } from "./policy.js";
import { approvalNotice, saveProjectConfirmation } from "./project-routing.js";
import { assertContextText } from "./project-context.js";
import type { Task } from "../shared/types.js";

/**
 * 對話串沒有使用者看得到的題數上限。內部只限制讀取深度，避免異常資料造成無窮迴圈；
 * 提示中最近 5 題給完整問答，更早的只給問題與「先看重點」，不另外呼叫 AI 摘要。
 */
export const threadReadLimit = 200;
const fullRounds = 5;
const condensedRounds = 45;
const answerLimit = 6000;
const keyPointLimit = 300;

export interface ThreadRound {
  id: string;
  title: string;
  mode: "query" | "change";
  status: string;
  question: string;
  answer?: string;
  /** 較早的題目只保留重點。 */
  keyPoints?: string;
  condensed?: boolean;
  prUrl?: string;
}

/** 回答開頭的「先看重點」段落；沒有就取去掉標頭後的前段文字。 */
export function keyPointsOf(answer: string) {
  const body = answer
    .split("\n")
    .filter((l) => !/^(查詢專案|基底分支|延續|一併查詢)：/.test(l))
    .join("\n");
  const m = /##\s*先看重點\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  const text = (m ? m[1] : body).replace(/\s+/g, " ").trim();
  return text.length > keyPointLimit
    ? `${text.slice(0, keyPointLimit)}…`
    : text;
}

type Queryable = Pick<Database, "query">;

/** 這一題往上的對話串（不含自己），由舊到新，最多 limit 題。 */
export async function threadAncestors(
  db: Queryable,
  task: Pick<Task, "parent_id">,
  limit = fullRounds,
) {
  if (!task.parent_id) return [];
  return db.query<{
    id: string;
    title: string;
    mode: "query" | "change";
    status: string;
    summary: string;
    answer: string | null;
    pr_url: string | null;
    created_at: string;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT id,parent_id,title,mode,status,summary,answer,pr_url,created_at,1 AS n FROM tasks WHERE id=$1
       UNION ALL
       SELECT t.id,t.parent_id,t.title,t.mode,t.status,t.summary,t.answer,t.pr_url,t.created_at,chain.n+1
       FROM tasks t JOIN chain ON t.id=chain.parent_id WHERE chain.n<$2)
     SELECT id,title,mode,status,summary,answer,pr_url,created_at FROM chain ORDER BY n DESC`,
    [task.parent_id, limit],
  );
}

/** 給 Codex 的先前各題：問題、回答（截斷）或 PR 連結。內容已在寫入時遮蔽機密，這裡再遮一次。 */
export async function threadHistory(
  db: Queryable,
  task: Pick<Task, "parent_id">,
): Promise<ThreadRound[]> {
  const rounds = await threadAncestors(db, task, fullRounds + condensedRounds);
  return rounds.map((r, i) => {
    const answer = r.answer ? redact(r.answer) : undefined;
    if (i < rounds.length - fullRounds)
      return {
        id: r.id,
        title: r.title,
        mode: r.mode,
        status: r.status,
        question: redact(r.summary).slice(0, 500),
        ...(answer ? { keyPoints: keyPointsOf(answer) } : {}),
        ...(r.pr_url ? { prUrl: r.pr_url } : {}),
        condensed: true,
      };
    return {
      id: r.id,
      title: r.title,
      mode: r.mode,
      status: r.status,
      question: redact(r.summary),
      ...(answer
        ? {
            answer:
              answer.length > answerLimit
                ? `${answer.slice(0, answerLimit)}…（回答較長，已截斷）`
                : answer,
          }
        : {}),
      ...(r.pr_url ? { prUrl: r.pr_url } : {}),
    };
  });
}

/** 看板用：這一題往上的對話串與直接的後續各題。 */
export async function threadOf(db: Queryable, task: Task) {
  const before = await threadAncestors(db, task, 50);
  const after = await db.query<{
    id: string;
    title: string;
    mode: string;
    status: string;
    created_at: string;
  }>(
    "SELECT id,title,mode,status,created_at FROM tasks WHERE parent_id=$1 ORDER BY created_at",
    [task.id],
  );
  return {
    before: before.map(({ id, title, mode, status, created_at }) => ({
      id,
      title,
      mode,
      status,
      created_at,
    })),
    after,
  };
}

/** taskId 的祖先中是否有 ancestorId（用來避免把一題改接到自己的後續題，形成循環）。 */
async function hasAncestor(c: DbClient, taskId: string, ancestorId: string) {
  return !!(
    await c.query(
      `WITH RECURSIVE chain AS (SELECT id,parent_id,1 AS n FROM tasks WHERE id=$1
       UNION ALL SELECT t.id,t.parent_id,chain.n+1 FROM tasks t JOIN chain ON t.id=chain.parent_id WHERE chain.n<${threadReadLimit})
       SELECT 1 FROM chain WHERE id=$2 LIMIT 1`,
      [taskId, ancestorId],
    )
  ).rowCount;
}

/**
 * 看板上對已回答的查詢追問：建立新的一題，沿用上一題已確認的專案與分支，不蓋掉原回答。
 * 由登入成員親自提出，視同確認專案；索取機密實際值的追問仍要等人核准。
 */
export async function createFollowup(
  db: Database,
  parentId: string,
  text: string,
  actor: string,
) {
  const question = text.trim();
  if (!question) throw new AppError(422, "請輸入要追問的內容");
  if (question.length > 2000)
    throw new AppError(422, "追問請在 2,000 字內，較長的需求請另開任務");
  assertContextText(question);
  return db.transaction(async (c) => {
    const parent = (
      await c.query<Task>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [
        parentId,
      ])
    ).rows[0];
    if (!parent) throw new AppError(404, "找不到任務");
    const t = await createFollowupInTransaction(db, c, parent, question, actor);
    return { id: t.id, status: t.status };
  });
}

/** 共用追問交易，修改假設時沿用對話串、風險與專案檢查，不覆寫已回答的原題。 */
export async function createFollowupInTransaction(
  db: Database,
  c: DbClient,
  parent: Task,
  question: string,
  actor: string,
  options: {
    assumptions?: string[];
    acceptance?: string[];
    riskText?: string;
    retainedRisk?: string;
  } = {},
) {
  if (parent.mode !== "query" || parent.status !== "answered")
    throw new AppError(409, "只有已回答的查詢可以追問");
  const usable = (
    await c.query(
      `SELECT g.binding_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id JOIN groups g ON g.id=gp.group_id
         WHERE p.id=$1 AND g.id=$2 AND p.enabled AND p.validated_at IS NOT NULL AND g.left_at IS NULL`,
      [parent.project_id, parent.group_id],
    )
  ).rows[0] as { binding_version: number } | undefined;
  if (!usable)
    throw new AppError(
      409,
      "這個專案已停用或不再綁定此群組，請另外提出查詢並指定專案",
    );
  const risk = queryRisk(options.riskText ?? question) || options.retainedRisk;
  const t = (
    await c.query<Task>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,risk_reasons,missing,source_ids,status,approved_version,parent_id,dedupe_key,suggestions,mode)
         VALUES($1,$2,$3,$4,$5,$6,'[]','{}',$7,$8,$9,$10,'[]','query') RETURNING *`,
      [
        parent.project_id,
        parent.group_id,
        `追問：${question.replace(/\s+/g, " ").slice(0, 60)}`,
        question,
        JSON.stringify(
          options.acceptance ?? [`回答追問：${question.slice(0, 500)}`],
        ),
        JSON.stringify(risk ? [risk] : []),
        risk ? "awaiting_approval" : "queued",
        risk ? null : 1,
        parent.id,
        `followup:${parent.id}:${randomUUID()}`,
      ],
    )
  ).rows[0];
  if (options.assumptions) {
    await c.query("UPDATE tasks SET assumptions=$2 WHERE id=$1", [
      t.id,
      JSON.stringify(options.assumptions),
    ]);
    t.assumptions = options.assumptions;
  }
  const routing = {
    status: "clear",
    basis: "followup",
    reason: `延續上一題「${parent.title}」，沿用同一個專案與分支`,
    evidence: [],
    bindingVersion: usable.binding_version,
    followupOf: { id: parent.id, title: parent.title },
  };
  const selection = {
    basis: "followup",
    reason: `延續上一題的目標分支「${parent.target_branch}」`,
    sourceIds: [],
  };
  await c.query(
    "UPDATE tasks SET project_routing=$2,target_branch=$3,branch_selection=$4 WHERE id=$1",
    [
      t.id,
      JSON.stringify(routing),
      parent.target_branch,
      JSON.stringify(selection),
    ],
  );
  Object.assign(t, {
    project_routing: routing,
    target_branch: parent.target_branch,
    branch_selection: selection,
  });
  await c.query(
    "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,1,$2,$3,$4)",
    [t.id, t.summary, JSON.stringify(t.acceptance), risk ? null : actor],
  );
  await db.audit(
    t.id,
    "followup",
    `${actor} 在看板追問「${parent.title}」${risk ? "，涉及機密實際值，等待審核" : "，已自動排程"}`,
    c,
  );
  if (risk) await approvalNotice(c, t);
  else await saveProjectConfirmation(c, t, "manual", actor);
  return t;
}

/**
 * 接錯題時改正：改接到同群組的另一題（沿用它的專案與分支），或改成新話題（等管理者確認專案）。
 * 由登入成員操作；查詢沒有風險時直接重新排程，否則等待確認。執行中的任務不能改。
 */
export async function relinkTask(
  db: Database,
  taskId: string,
  version: number,
  parentId: string | null,
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
      throw new AppError(409, "任務已經更新，請重新整理");
    if (
      ![
        "awaiting_approval",
        "queued",
        "failed",
        "budget_wait",
        "answered",
      ].includes(t.status)
    )
      throw new AppError(409, "處理中的任務不能改接，請等它結束或先取消");
    if (parentId === t.parent_id) throw new AppError(422, "已經是接續這一題");
    let parent: Task | undefined;
    let usable: { binding_version: number } | undefined;
    if (parentId) {
      parent = (
        await c.query<Task>("SELECT * FROM tasks WHERE id=$1 AND group_id=$2", [
          parentId,
          t.group_id,
        ])
      ).rows[0];
      if (!parent || parent.id === t.id)
        throw new AppError(422, "只能改接到同一個群組的其他題");
      if (await hasAncestor(c, parent.id, t.id))
        throw new AppError(422, "不能改接到這一題後面的追問");
      usable = (
        await c.query(
          `SELECT g.binding_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id JOIN groups g ON g.id=gp.group_id
           WHERE p.id=$1 AND g.id=$2 AND p.enabled AND p.validated_at IS NOT NULL AND g.left_at IS NULL`,
          [parent.project_id, t.group_id],
        )
      ).rows[0] as { binding_version: number } | undefined;
      if (!usable || !parent.target_branch)
        throw new AppError(409, "那一題的專案已停用或不再綁定此群組");
    }
    const auto =
      !!parent &&
      t.mode === "query" &&
      !t.risk_reasons.length &&
      !t.missing.length &&
      !t.question;
    const routing = parent
      ? {
          status: "clear",
          basis: "followup",
          reason: `改接到「${parent.title}」，沿用同一個專案與分支`,
          evidence: [],
          bindingVersion: usable!.binding_version,
          followupOf: { id: parent.id, title: parent.title },
        }
      : {
          status: "uncertain",
          basis: "none",
          reason: "改成新話題，請確認這次要處理的專案",
          evidence: [],
          bindingVersion: 0,
        };
    const selection = parent
      ? {
          basis: "followup",
          reason: `延續「${parent.title}」的目標分支「${parent.target_branch}」`,
          sourceIds: [],
        }
      : t.branch_selection;
    const updated = (
      await c.query<Task>(
        `UPDATE tasks SET parent_id=$2,project_id=COALESCE($3,project_id),target_branch=COALESCE($4,target_branch),
           project_routing=$5,branch_selection=$6,version=version+1,
           approved_version=CASE WHEN $7 THEN version+1 ELSE NULL END,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,
           status=CASE WHEN $7 THEN 'queued' ELSE 'awaiting_approval' END,last_error=NULL,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          t.id,
          parent?.id ?? null,
          parent?.project_id ?? null,
          parent?.target_branch ?? null,
          JSON.stringify(routing),
          JSON.stringify(selection),
          auto,
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        updated.id,
        updated.version,
        updated.summary,
        JSON.stringify(updated.acceptance),
        auto ? actor : null,
      ],
    );
    await db.audit(
      updated.id,
      "relinked",
      parent
        ? `${actor} 把接續對象改成「${parent.title}」${auto ? "，已重新排程" : "，等待確認"}`
        : `${actor} 改成新話題，等待確認專案`,
      c,
    );
    if (auto) await saveProjectConfirmation(c, updated, "manual", actor);
    else await approvalNotice(c, updated);
    return { id: updated.id, status: updated.status };
  });
}
