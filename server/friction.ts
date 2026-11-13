import type { Database } from "./db.js";
import type { FrictionMetrics } from "../shared/friction.js";

/**
 * 使用摩擦指標：衡量使用者「有沒有感覺到流程」。全部從既有資料表與稽核紀錄計算，不另外記錄。
 * 期間以任務建立時間計算；可依群組篩選。
 */

/** 需要人親自回應的稽核種類（看板操作、回答補問、改接）。 */
const humanKinds = [
  "approve",
  "reject",
  "amend",
  "assign",
  "adopt",
  "mode",
  "target",
  "reopen",
  "retry",
  "cancel",
  "assumption",
  "assumption_changed",
  "question_answered",
  "relinked",
  "followup",
];
/** 其中一定要在看板操作的種類；LINE 回答補問不算。 */
const dashboardKinds = humanKinds.filter((k) => k !== "question_answered");

export async function frictionMetrics(
  db: Pick<Database, "one">,
  days: number,
  groupId: string | null,
): Promise<FrictionMetrics> {
  const r = await db.one<Record<string, string | number | null>>(
    `WITH scope AS (
       SELECT t.* FROM tasks t
       WHERE t.created_at>now()-make_interval(days=>$1) AND ($2::text IS NULL OR t.group_id=$2)
     ),
     human AS (
       SELECT a.task_id,count(*) FILTER (WHERE a.kind=ANY($3)) AS responses,
         count(*) FILTER (WHERE a.kind=ANY($4) OR (a.kind='question_answered' AND a.detail NOT LIKE '群組成員%')) AS dashboard
       FROM audit a JOIN scope s ON s.id=a.task_id GROUP BY a.task_id
     ),
     started AS (
       SELECT s.id,COALESCE((SELECT min(m.received_at) FROM messages m WHERE m.id=ANY(s.source_ids)),s.created_at) AS at FROM scope s
     ),
     first_reply AS (
       SELECT extract(epoch FROM min(n.sent_at)-st.at) AS seconds
       FROM started st JOIN notifications n ON n.task_id=st.id AND n.group_id IS NOT NULL AND n.sent_at IS NOT NULL
       GROUP BY st.id,st.at
     ),
     answered AS (
       SELECT extract(epoch FROM a.created_at-st.at) AS seconds
       FROM scope s JOIN started st ON st.id=s.id
       JOIN LATERAL (SELECT min(created_at) AS created_at FROM audit WHERE task_id=s.id AND kind='answered') a ON a.created_at IS NOT NULL
       WHERE s.mode='query'
     ),
     merged AS (
       SELECT s.id,(SELECT min(created_at) FROM audit WHERE task_id=s.id AND kind='merged') AS merged_at
       FROM scope s WHERE s.mode<>'query' AND s.status='merged'
     )
     SELECT
       (SELECT count(*) FROM scope) AS tasks,
       (SELECT avg(COALESCE(h.responses,0)) FROM scope s LEFT JOIN human h ON h.task_id=s.id) AS responses,
       (SELECT avg(COALESCE(h.dashboard,0)) FROM scope s LEFT JOIN human h ON h.task_id=s.id) AS dashboard,
       (SELECT count(*) FROM scope s WHERE s.parent_id IS NULL AND s.project_routing->>'basis'='explicit'
          AND EXISTS(SELECT 1 FROM tasks p WHERE p.group_id=s.group_id AND p.project_id=s.project_id AND p.id<>s.id
            AND p.status IN ('answered','ready','merged') AND p.updated_at BETWEEN s.created_at-interval '30 minutes' AND s.created_at)) AS restated,
       (SELECT count(*) FROM audit a JOIN scope s ON s.id=a.task_id WHERE a.kind='relinked') AS relinked,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FROM first_reply WHERE seconds>=0) AS first_reply,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FROM answered WHERE seconds>=0) AS answer,
       (SELECT count(*) FROM merged WHERE merged_at IS NOT NULL) AS rework_base,
       (SELECT count(*) FROM merged m WHERE m.merged_at IS NOT NULL AND EXISTS(
          SELECT 1 FROM tasks c WHERE c.parent_id=m.id AND c.mode<>'query' AND c.created_at BETWEEN m.merged_at AND m.merged_at+interval '7 days')) AS rework`,
    [days, groupId, humanKinds, dashboardKinds],
  );
  const num = (v: unknown) =>
    v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;
  const base = Number(r.rework_base ?? 0);
  return {
    days,
    groupId,
    tasks: Number(r.tasks ?? 0),
    responsesPerTask: Number(r.tasks) ? num(r.responses) : null,
    dashboardPerTask: Number(r.tasks) ? num(r.dashboard) : null,
    restated: Number(r.restated ?? 0),
    relinked: Number(r.relinked ?? 0),
    firstReplySeconds: num(r.first_reply),
    answerSeconds: num(r.answer),
    reworkRate: base ? num(Number(r.rework ?? 0) / base) : null,
    reworkBase: base,
  };
}
