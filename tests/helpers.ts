import { Database } from "../server/db.js";
import { hash } from "../server/auth.js";
export const testUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentflowtest:test-only-password@127.0.0.1:5439/agentflow_test";
if (!new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("測試資料庫名稱必須以 _test 結尾");
export const db = new Database(testUrl);
export async function reset() {
  await db.migrate();
  await db.query("UPDATE rag_backfill SET active=false,completed_at=NULL");
  await db.query(
    "TRUNCATE members,alert_seen,rag_pending,embeddings,group_memories,group_projects,notifications,usage,runs,reservations,task_versions,audit,tasks,messages,events,groups,projects,sessions,pairing_codes,oauth_states RESTART IDENTITY CASCADE",
  );
  await db.query(
    `UPDATE settings SET value='{"rag_enabled":false,"paused":false,"ai_mode":"api","daily_runs":20,"daily_budget":15,"task_budget":3,"task_minutes":30,"triage_model":"gpt-5.4-mini","coding_model":"gpt-6.1-sol","retention_days":30,"admin_line_id":null}' WHERE id=1`,
  );
}
export async function fixture() {
  const p = await db.one<{ id: string }>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('測試專案','test/repo',true,now()) RETURNING id",
  );
  await db.query(
    "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-a','測試群組',true,'auto')",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
    [p.id],
  );
  return p.id;
}
export async function session() {
  await db.query(
    "INSERT INTO sessions VALUES($1,'1000001','test-csrf',now()+interval '1 hour') ON CONFLICT(id_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at",
    [hash("test-session")],
  );
  return {
    cookie: "af_session=test-session",
    "x-csrf-token": "test-csrf",
    origin: "http://localhost:4310",
  };
}

/** 測試前置資料：此需求版本已由看板成員確認專案。流程測試仍須呼叫管理 API。 */
export async function confirmTask(id: string) {
  await db.query(`INSERT INTO task_project_confirmations(task_id,version,project_id,config_version,binding_version,mode,kind,actor,target_branch)
    SELECT t.id,t.version,p.id,p.config_version,g.binding_version,t.mode,'manual','測試審核者',t.target_branch
    FROM tasks t JOIN projects p ON p.id=t.project_id JOIN groups g ON g.id=t.group_id WHERE t.id=$1
    ON CONFLICT(task_id,version) DO UPDATE SET project_id=EXCLUDED.project_id,config_version=EXCLUDED.config_version,binding_version=EXCLUDED.binding_version,mode=EXCLUDED.mode,target_branch=EXCLUDED.target_branch`, [id]);
}

export async function dashboardAction(id: string, action: string, version: number, body: Record<string, unknown> = {}) {
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db);
  try {
    const headers = await session();
    const detail = (await app.inject({url: `/api/tasks/${id}`, headers})).json();
    const review = detail.projectReview;
    const response = await app.inject({method: "POST", url: `/api/tasks/${id}/actions`, headers, payload: {
      action, version, project_id: detail.task.project_id, binding_version: review.binding_version, config_version: review.config_version, target_branch:detail.task.target_branch, ...body,
    }});
    if (response.statusCode >= 400) throw new Error(response.json().error ?? response.json().message);
    return response.json();
  } finally { await app.close(); }
}
