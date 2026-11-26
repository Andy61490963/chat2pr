import { taskGroups } from "../shared/types.js";
import type { Database } from "./db.js";
import { groupReplyStillUncertain } from "./reply-uncertain.js";
import { notificationProject } from "./notification-project.js";
import { liveStuckNotice } from "./stuck-tasks.js";

/** 依目前狀態判斷通知是否仍待處理，歷史通知與 LINE 投遞紀錄照常保留。 */
export function dashboardAlerts(db: Database, admin: boolean) {
  return db.query(
    `WITH classified AS (
       SELECT n.id,n.kind,n.created_at,p.id AS project_id,t.status,
         CASE
           WHEN NOT $1 AND n.task_id IS NULL AND n.group_id IS NULL THEN false
           WHEN n.kind='reply_uncertain' THEN ${groupReplyStillUncertain}
           WHEN n.kind IN ('approval','risk','input_required','ready')
             AND split_part(n.dedupe_key,':',3) ~ '^[0-9]+$'
             AND split_part(n.dedupe_key,':',3)<>t.version::text THEN false
           WHEN n.kind IN ('approval','risk','group_received') AND n.task_id IS NOT NULL
             THEN t.status='awaiting_approval'
           WHEN n.kind IN ('input_required','group_question')
             THEN coalesce(t.status='awaiting_approval' AND t.question IS NOT NULL
               AND n.dedupe_key IN ('input:'||t.id||':'||t.version,'group:question:'||t.id||':'||t.version),false)
           WHEN n.kind IN ('failed','group_failed','interrupted') AND n.task_id IS NOT NULL
             THEN t.status='failed'
           WHEN n.kind IN ('ready','group_ready','ci') AND n.task_id IS NOT NULL
             THEN t.status='ready'
           WHEN n.kind='project_input'
             THEN coalesce(n.dedupe_key IN ('project-input:'||(p.setup_input->>'id'),
               'project-input:'||p.id||':'||(p.setup_input->>'id')),false)
           WHEN n.kind='repo_missing' AND p.id IS NOT NULL THEN p.repo_missing_at IS NOT NULL
           WHEN n.kind='group_new' AND g.id IS NOT NULL THEN NOT g.enabled AND g.left_at IS NULL
             -- 已綁專案卻停用的群組是管理者刻意停用，不再算待設定的新群組。
             AND NOT EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=g.id)
           WHEN n.kind='service_down' AND split_part(n.dedupe_key,':',2)='codex_inference'
             THEN coalesce(NOT h.notified_ok AND h.outage_started_at=n.line_outage_started_at AND EXISTS (
               SELECT 1 FROM settings WHERE id=1 AND value->>'ai_mode'='subscription'
               AND (value->>'codex_model') IS NOT DISTINCT FROM (h.probe_info->>'model')),false)
           WHEN n.kind='service_down' AND h.name IS NOT NULL THEN NOT coalesce(h.notified_ok,h.ok)
           WHEN n.kind='stuck_tasks' THEN ${liveStuckNotice}
           WHEN n.kind IN ('group_waiting','budget','group_received','auto_resume','group_resumed') THEN false
         END AS action,
         CASE WHEN n.kind='reply_uncertain' THEN n.dedupe_key
           ELSE coalesce('task:'||n.task_id,n.kind||':'||coalesce(p.id::text,g.id,h.name),n.id::text) END AS action_key
       FROM notifications n
       LEFT JOIN tasks t ON t.id=n.task_id
       LEFT JOIN projects p ON $1 AND p.id=(${notificationProject})
       LEFT JOIN groups g ON $1 AND n.kind='group_new' AND g.id=split_part(n.dedupe_key,':',2)
       LEFT JOIN service_health h ON $1 AND n.kind='service_down' AND h.name=split_part(n.dedupe_key,':',2)
       WHERE $1 OR n.kind<>'reply_uncertain'
     ), actionable AS (
       SELECT DISTINCT ON (action_key) id,created_at,project_id,
         CASE WHEN kind<>'reply_uncertain' AND status=ANY($2::text[]) THEN 'inbox' ELSE 'action' END AS disposition
       FROM classified WHERE action
       ORDER BY action_key,(kind IN ('input_required','group_question')) DESC,
         (kind NOT IN ('group_received','group_failed','group_ready')) DESC,created_at DESC,id DESC
     ), history AS (
       SELECT id,created_at,project_id,
         CASE WHEN action IS NULL THEN 'result' ELSE 'resolved' END AS disposition
       FROM classified WHERE NOT EXISTS (SELECT 1 FROM actionable a WHERE a.id=classified.id)
       ORDER BY created_at DESC,id DESC LIMIT 30
     )
     SELECT n.id,n.task_id,n.kind,n.created_at,t.title,alerts.project_id,alerts.disposition,
       CASE WHEN n.group_id IS NOT NULL AND n.created_at<=message_retention_cutoff() THEN '原文已到期'
            WHEN n.group_id IS NOT NULL OR $1::boolean THEN n.text
            WHEN n.task_id IS NOT NULL THEN '請到任務詳情查看。'
            ELSE '管理者私訊' END AS text
     FROM (
       SELECT * FROM actionable UNION ALL SELECT * FROM history
     ) alerts
     JOIN notifications n ON n.id=alerts.id
     LEFT JOIN tasks t ON t.id=n.task_id
     ORDER BY (alerts.disposition IN ('inbox','action')) DESC,n.created_at DESC,n.id DESC`,
    [admin, taskGroups.attention],
  );
}
