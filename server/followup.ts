import { randomUUID } from "node:crypto";
import type { Database, DbClient } from "./db.js";
import { AppError, classifyRisk, queryRisk, redact } from "./policy.js";
import { approvalNotice, saveProjectConfirmation } from "./project-routing.js";
import { assertContextText } from "./project-context.js";
import type { Task } from "../shared/types.js";

/** 一串追問最多幾題；超過就請使用者開新話題，避免提示越來越長。 */
export const maxThreadDepth = 10;
/** 交給 Codex 的先前題數與每題回答長度上限。 */
const promptRounds = 5;
const answerLimit = 6000;

export interface ThreadRound {
  id: string;
  title: string;
  mode: "query" | "change";
  status: string;
  question: string;
  answer?: string;
  prUrl?: string;
}

type Queryable = Pick<Database, "query">;

/** 這一題往上的對話串（不含自己），由舊到新，最多 limit 題。 */
export async function threadAncestors(
  db: Queryable,
  task: Pick<Task, "parent_id">,
  limit = promptRounds,
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
  return (await threadAncestors(db, task)).map((r) => {
    const answer = r.answer ? redact(r.answer) : undefined;
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
  const before = await threadAncestors(db, task, maxThreadDepth);
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

async function depthOf(c: DbClient, taskId: string) {
  return Number(
    (
      await c.query(
        "WITH RECURSIVE chain AS (SELECT id,parent_id,1 AS n FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,chain.n+1 FROM tasks t JOIN chain ON t.id=chain.parent_id WHERE chain.n<20) SELECT max(n) AS n FROM chain",
        [taskId],
      )
    ).rows[0].n,
  );
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
    const t =
      parent.mode === "query"
        ? await createFollowupInTransaction(db, c, parent, question, actor)
        : await createChangeFollowup(db, c, parent, question, actor);
    return { id: t.id, status: t.status };
  });
}

/**
 * 修改的追加：PR 還開著時，派工會接在同一個 PR 上；已合併就從目標分支另開 PR，並帶入原需求脈絡。
 * 修改一律等管理者確認，這裡只建立待確認的新一題。
 */
async function createChangeFollowup(
  db: Database,
  c: DbClient,
  parent: Task,
  text: string,
  actor: string,
) {
  if (!["ready", "merged", "closed"].includes(parent.status))
    throw new AppError(
      409,
      "只有已開出 PR 或已合併的修改可以追加；還在處理中的需求請直接補充",
    );
  const usable = (
    await c.query(
      `SELECT g.binding_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id JOIN groups g ON g.id=gp.group_id
       WHERE p.id=$1 AND g.id=$2 AND p.enabled AND p.validated_at IS NOT NULL AND g.left_at IS NULL`,
      [parent.project_id, parent.group_id],
    )
  ).rows[0] as { binding_version: number } | undefined;
  if (!usable || !parent.target_branch)
    throw new AppError(
      409,
      "這個專案已停用或不再綁定此群組，請另外提出需求並指定專案",
    );
  const risk = classifyRisk(text, []);
  const t = (
    await c.query<Task>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,risk_reasons,missing,source_ids,status,parent_id,dedupe_key,suggestions,mode)
       VALUES($1,$2,$3,$4,$5,$6,'[]','{}','awaiting_approval',$7,$8,'[]','change') RETURNING *`,
      [
        parent.project_id,
        parent.group_id,
        `追加：${text.replace(/\s+/g, " ").slice(0, 60)}`,
        text,
        JSON.stringify([`完成追加：${text.slice(0, 500)}`]),
        JSON.stringify(risk ? [risk] : []),
        parent.id,
        `followup:${parent.id}:${randomUUID()}`,
      ],
    )
  ).rows[0];
  const routing = {
    status: "clear",
    basis: "followup",
    reason: `追加「${parent.title}」，沿用同一個專案與分支${parent.status === "ready" ? "，接在同一個 PR 上" : ""}`,
    evidence: [],
    bindingVersion: usable.binding_version,
    followupOf: { id: parent.id, title: parent.title },
  };
  await c.query(
    "UPDATE tasks SET project_routing=$2,target_branch=$3,branch_selection=$4 WHERE id=$1",
    [
      t.id,
      JSON.stringify(routing),
      parent.target_branch,
      JSON.stringify({
        basis: "followup",
        reason: `延續上一題的目標分支「${parent.target_branch}」`,
        sourceIds: [],
      }),
    ],
  );
  Object.assign(t, {
    project_routing: routing,
    target_branch: parent.target_branch,
  });
  await c.query(
    "INSERT INTO task_versions(task_id,version,summary,acceptance) VALUES($1,1,$2,$3)",
    [t.id, t.summary, JSON.stringify(t.acceptance)],
  );
  await db.audit(t.id, "followup", `${actor} 在看板追加「${parent.title}」`, c);
  await approvalNotice(c, t);
  return t;
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
  if ((await depthOf(c, parent.id)) >= maxThreadDepth)
    throw new AppError(409, "這串追問已經 10 題，請另外提出新的查詢");
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
