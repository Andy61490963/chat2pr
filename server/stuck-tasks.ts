import { randomUUID } from "node:crypto";
import { waitHint } from "../shared/failure-text.js";
import { HEARTBEAT_STALE_MS } from "../shared/run-progress.js";
import type { StuckTask } from "../shared/stuck-tasks.js";
import type { Settings, TaskStatus } from "../shared/types.js";
import { queueSnapshot } from "./capacity.js";
import type { Database } from "./db.js";
import { noticeDelay } from "./health.js";
import { commonFailure, type FailureEvidence } from "./stuck-failures.js";

type Candidate = {
  id: string;
  version: number;
  status: TaskStatus;
  project_id: string | null;
  question: boolean;
  options: boolean;
  missing: boolean;
  confirmed: boolean;
  approved: boolean;
  last_error: string | null;
  run_id: string | null;
  overdue: boolean;
};

type Advice = Pick<StuckTask, "reason" | "target" | "actionLabel">;
type Observation = Pick<Candidate, "id" | "status" | "version"> & Advice & { episode: string };

const liveStall = "JOIN tasks t ON t.id=s.task_id AND t.version=s.version AND t.status=s.status";
export const liveStuckNotice = `EXISTS (SELECT 1 FROM task_stalls s ${liveStall} WHERE s.notice_id=n.id)`;

export function stuckTasks(db: Database) {
  return db.query<StuckTask>(
    `SELECT t.id AS "taskId",t.title,s.reason,s.target,s.action_label AS "actionLabel"
     FROM task_stalls s ${liveStall} ORDER BY s.since,t.updated_at,t.id`,
  );
}

const taskAdvice = (reason: string, actionLabel: string): Advice => ({ reason, target: "task", actionLabel });
const systemAdvice = (reason: string, actionLabel: string): Advice => ({ reason, target: "system", actionLabel });

type QueueSnapshot = Awaited<ReturnType<typeof queueSnapshot>>;
async function queueConditions(db: Database, now: Date) {
  const [snapshot, current] = await Promise.all([
    queueSnapshot(db, undefined, null),
    db.one<{ daily: boolean; offline: boolean }>(
      `SELECT value->>'ai_mode'='subscription' AND
         (SELECT count(*) FROM runs WHERE (started_at AT TIME ZONE 'Asia/Taipei')::date=
           ($1::timestamptz AT TIME ZONE 'Asia/Taipei')::date)>=(value->>'daily_runs')::int AS daily,
         EXISTS(SELECT 1 FROM service_health WHERE name='runner' AND NOT ok
           AND checked_at BETWEEN $1::timestamptz-interval '70 minutes' AND $1) AS offline
       FROM settings WHERE id=1`, [now],
    ),
  ]);
  return {
    byId: new Map(snapshot.queued.map((entry) => [entry.id, entry])),
    full: snapshot.running.length >= snapshot.limit,
    ...current,
  };
}

function queueAdvice(task: Candidate, entry: QueueSnapshot["queued"][number], conditions: Awaited<ReturnType<typeof queueConditions>>): Advice {
  switch (entry.code) {
    case "disk": case "memory": case "paused":
      return systemAdvice(entry.text, "查看派工狀態");
    case "project": case "group":
      return taskAdvice(entry.text.startsWith("專案驗證未通過：") ? "專案驗證未通過" : entry.text, "查看任務與綁定");
    case "parent": case "retry": case "changing":
      return taskAdvice(entry.text, "查看排隊原因");
  }
  if (!task.approved) return taskAdvice("目前需求版本尚未核准，不能派工。", "查看需求版本");
  if (!task.confirmed) return taskAdvice("目前需求版本的目標專案尚未確認。", "查看專案確認");
  if (conditions.full) return systemAdvice("同時執行數已滿，正在等待工作結束。", "查看執行容量");
  if (conditions.daily) return systemAdvice("今日執行次數已用完，臺北時間午夜後重新計算。", "查看今日用量");
  if (conditions.offline) return systemAdvice("最近一次執行器連線檢查失敗。", "查看執行器狀態");
  if (entry.code === "waiting") return taskAdvice("前面還有其他工作排隊。", "查看排隊順序");
  return systemAdvice("已排隊至少 10 分鐘仍未派出，目前沒有查到阻擋原因。", "查看派工狀態");
}

function waitingAdvice(task: Candidate, mode: Settings["ai_mode"]): Advice {
  if (task.status === "budget_wait")
    return systemAdvice(waitHint(task.last_error, mode) ?? "已達訂閱保留比例，工作仍在等待可用額度。", "查看用量");
  if (task.status === "running" || task.status === "reviewing") {
    if (task.overdue) return taskAdvice("已超過本次執行期限與 2 分鐘緩衝，尚未結束。", "查看執行紀錄");
    return taskAdvice(task.run_id ? "執行心跳超過 30 秒未更新，尚無法確認工作是否仍在執行。" : "沒有找到這筆任務進行中的執行紀錄。", "查看執行紀錄");
  }
  if (task.status === "ready") return taskAdvice("變更送出已滿一天，尚待確認合併結果。", "查看合併狀態");
  if (task.question) return taskAdvice("已等待補問回答滿一天，尚未取得繼續工作的資訊。", "回答補問");
  if (!task.project_id) return taskAdvice("已等待選擇目標專案滿一天。", "選擇專案");
  if (task.options) return taskAdvice("已等待選擇方案滿一天。", "查看方案");
  if (task.missing) return taskAdvice("已等待補充需求滿一天。", "查看待補項目");
  return taskAdvice("已等待人工審核滿一天，尚未決定是否派工。", "查看待審需求");
}

async function repeatedFailures(db: Database) {
  const rows = await db.query<Pick<Candidate, "id" | "version" | "status" | "project_id"> & { evidence: FailureEvidence[] }>(
    `WITH recent AS (
       SELECT r.id,r.task_id,r.version,r.outcome,r.started_at,r.completed_at,r.reservation_id,r.status AS phase,coalesce(r.change_project_id,t.project_id) AS project_id,
         row_number() OVER (PARTITION BY coalesce(r.change_project_id,t.project_id) ORDER BY r.completed_at DESC,r.id DESC) AS pos
       FROM runs r JOIN tasks t ON t.id=r.task_id
       WHERE r.completed_at IS NOT NULL AND r.started_at>message_retention_cutoff()
         AND EXISTS (SELECT 1 FROM tasks f WHERE f.status='failed' AND f.project_id=coalesce(r.change_project_id,t.project_id))
     ), streaks AS (
       SELECT r.project_id,(array_agg(r.task_id ORDER BY pos))[1] AS task_id,(array_agg(r.version ORDER BY pos))[1] AS version,
         json_agg(json_build_object('detail',e.detail,'category',a.category) ORDER BY pos) AS evidence
       FROM recent r LEFT JOIN LATERAL (
         SELECT CASE WHEN exit_code<>0 THEN left(detail,80) END AS detail FROM run_events
         WHERE r.reservation_id IS NULL AND run_id=r.id AND source='runner' AND kind='phase_end' AND phase=r.phase AND phase IN ('code','review')
         ORDER BY seq DESC LIMIT 1
       ) e ON true
       LEFT JOIN LATERAL (
         SELECT substring(detail from '^([^（：]{1,10})[（：]') AS category FROM audit
         WHERE r.outcome='failed' AND task_id=r.task_id AND kind='error'
           AND created_at BETWEEN r.started_at AND r.completed_at
         ORDER BY created_at DESC,id DESC LIMIT 1
       ) a ON true
       WHERE pos<=3
       GROUP BY r.project_id HAVING count(*)=3 AND count(*) FILTER (WHERE r.outcome IN ('failed','queued'))=3
     ) SELECT t.id,t.version,t.status,t.project_id,s.evidence FROM streaks s JOIN tasks t
       ON t.id=s.task_id AND t.project_id=s.project_id AND t.version=s.version WHERE t.status='failed'`,
  );
  const observations: Observation[] = [];
  for (const row of rows) {
    const common = commonFailure(row.evidence);
    if (!common) continue;
    observations.push({
      id: row.id, version: row.version, status: row.status,
      episode: `project:${row.project_id}:${common.key}`,
      ...taskAdvice(`同專案最近 3 次執行都因「${common.reason}」失敗。`, "查看最近失敗紀錄"),
    });
  }
  return observations;
}

async function observe(db: Database, now: Date) {
  const rows = await db.query<Candidate>(
    `SELECT t.id,t.status,t.version,t.project_id,t.question IS NOT NULL AS question,
       t.suggestions<>'[]'::jsonb AS options,t.missing<>'[]'::jsonb AS missing,
       t.approved_version=t.version AS approved,CASE WHEN t.status='queued' THEN task_project_confirmed(t.id) END AS confirmed,
       CASE WHEN t.status='budget_wait' THEN t.last_error END AS last_error,r.id AS run_id,
       r.deadline <= $1::timestamptz-interval '2 minutes' AS overdue
     FROM tasks t LEFT JOIN runs r ON r.task_id=t.id AND r.completed_at IS NULL
     WHERE (t.status IN ('queued','budget_wait') AND t.updated_at <= $1::timestamptz-interval '10 minutes')
       OR (t.status IN ('awaiting_approval','ready') AND t.updated_at <= $1::timestamptz-interval '1 day')
       OR (t.status IN ('running','reviewing') AND (r.deadline <= $1::timestamptz-interval '2 minutes'
         OR coalesce(r.heartbeat_at,t.updated_at) < $1::timestamptz-$2::int*interval '1 millisecond'))`,
    [now, HEARTBEAT_STALE_MS],
  );
  const queue = rows.some((row) => row.status === "queued") ? await queueConditions(db, now) : null;
  const settings = rows.some((row) => row.status === "budget_wait") ? await db.settings() : null;
  const observations = await repeatedFailures(db);
  for (const row of rows) {
    let advice: Advice;
    if (row.status === "queued") {
      const entry = queue?.byId.get(row.id);
      if (!entry || !queue) continue;
      advice = queueAdvice(row, entry, queue);
    } else advice = waitingAdvice(row, settings?.ai_mode ?? "api");
    observations.push({
      episode: `task:${row.id}:${row.version}:${row.status}:${advice.reason}`,
      id: row.id, version: row.version, status: row.status, ...advice,
    });
  }
  return observations;
}

export async function checkStuckTasks(db: Database, now = new Date()) {
  await db.transaction(async (client) => {
    const { rows: [claim] } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('chat2pr:task_stalls')) AS locked");
    if (!claim.locked) return;
    const observations = await observe(db, now);
    await client.query("DELETE FROM task_stalls WHERE NOT (episode=ANY($1::text[]))", [observations.map((row) => row.episode)]);
    if (!observations.length) return;
    await client.query(
      `INSERT INTO task_stalls(episode,task_id,version,status,reason,action_label,target,since)
       SELECT x.episode,t.id,t.version,t.status,x.reason,x."actionLabel",x.target,$2
       FROM jsonb_to_recordset($1::jsonb) AS x(episode text,id uuid,version int,status text,reason text,"actionLabel" text,target text)
       JOIN tasks t ON t.id=x.id AND t.version=x.version AND t.status=x.status
       ON CONFLICT(episode) DO UPDATE SET task_id=excluded.task_id,version=excluded.version,reason=excluded.reason
       WHERE (task_stalls.task_id,task_stalls.version,task_stalls.reason) IS DISTINCT FROM (excluded.task_id,excluded.version,excluded.reason)`,
      [JSON.stringify(observations), now],
    );
    const noticeId = randomUUID();
    const { rows: reasons } = await client.query<{ reason: string; count: number }>(
      `WITH claimed AS (
         UPDATE task_stalls s SET notice_id=$1 FROM tasks t WHERE t.id=s.task_id AND t.status=s.status AND t.version=s.version
         AND s.notice_id IS NULL AND s.since <= $2::timestamptz-$3::int*interval '1 millisecond' RETURNING s.reason
       ) SELECT reason,count(*)::int AS count FROM claimed GROUP BY reason ORDER BY count DESC,reason`,
      [noticeId, now, noticeDelay.stuck_tasks],
    );
    if (!reasons.length) return;
    const total = reasons.reduce((sum, group) => sum + group.count, 0);
    const summary = reasons.slice(0, 3).map((group) => group.reason).join(" ");
    await client.query(
      `INSERT INTO notifications(id,kind,dedupe_key,text,created_at) VALUES($1,'stuck_tasks',$2,$3,$4)`,
      [noticeId, `stuck:${noticeId}`, `有 ${total} 筆任務卡住。請到收件匣查看原因與下一步。${summary}`, now],
    );
  });
}
