/** 管理者專案通知的目標。舊版補問只記錄問題編號，尚未回答時仍可定位。查詢的通知表別名須是 n。 */
export const notificationProject = `CASE WHEN n.kind IN ('repo_missing','repo_found','project_input') THEN (SELECT p.id FROM projects p WHERE p.id::text=split_part(n.dedupe_key,':',2)
              OR (n.kind='project_input' AND n.dedupe_key='project-input:'||(p.setup_input->>'id')) LIMIT 1) END`;
