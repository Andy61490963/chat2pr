// 真實容器驗收：資料庫與 GitHub／LINE 邊界隔離，Codex 使用服務專用登入。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pack } from "tar-stream";
import { Database } from "../server/db.ts";
import { Execution, HttpRunner } from "../server/execution.ts";
import { GitHub } from "../server/github.ts";
import { Line } from "../server/line.ts";
import { Budget } from "../server/budget.ts";
import { buildApp } from "../server/app.ts";
import { config, secrets } from "../server/config.ts";
import { hash } from "../server/auth.ts";
const c = config(),
  key = secrets();
assert(
  new URL(c.databaseUrl).pathname.endsWith("_observer_test"),
  "請使用專用的 _observer_test 資料庫",
);
assert(
  key.runnerSecret && !key.lineToken && !key.githubPrivateKey && !key.openaiKey,
  "請使用只含驗收執行器憑證的設定",
);
assert(new URL(c.runnerUrl).port !== "4312", "請啟動獨立的驗收執行器");
const db = new Database(c.databaseUrl),
  runner = new HttpRunner();
// 隔離驗收使用自建封存檔，不授予虛構儲存庫真實 GitHub 存取權。
runner.prepareSource = undefined;
let runId, app;
try {
  await db.migrate();
  await db.query(
    `UPDATE settings SET value=value || '{"paused":false,"ai_mode":"subscription","rag_enabled":false,"codex_model":"gpt-6.1-sol","task_minutes":5,"daily_runs":20}'::jsonb`,
  );
  const group = randomUUID();
  await db.query(
    "INSERT INTO groups(id,name,enabled) VALUES($1,'唯讀監看驗收',true)",
    [group],
  );
  const p =
    await db.one(`INSERT INTO projects(name,repo,image,install_command,test_command,enabled,validated_at)
    VALUES('監看驗收','fixture/observer','line-agentflow-worker:observer','true','test -f README.md && grep -q 完成 README.md',true,now()) RETURNING *`);
  await db.query("INSERT INTO group_projects VALUES($1,$2)", [group, p.id]);
  const task = await db.one(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key)
    VALUES($1,$2,'更新驗收說明','請讀取 README.md，將唯一一行待辦改成完成。使用 shell 確認變更，保留其他檔案。','["README.md 只有完成一行"]','queued',1,$3) RETURNING *`,
    [p.id, group, randomUUID()],
  );
  const gh = new GitHub(),
    line = new Line(db);
  gh.base = async () => "fixture-base";
  gh.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/fixture/observer/issues/1",
  });
  gh.findPr = async () => undefined;
  gh.archive = async () => {
    const tar = pack();
    tar.entry({ name: "repo/README.md" }, "待辦\n");
    tar.finalize();
    const blocks = [];
    for await (const b of tar) blocks.push(b);
    return new Blob([Buffer.concat(blocks)]).stream();
  };
  let published = false;
  gh.publish = async (_p, _t, files, _report, guard) => {
    await guard();
    assert(
      files.some(
        (f) =>
          f.path === "README.md" &&
          Buffer.from(f.content, "base64").toString("utf8").includes("完成"),
      ),
    );
    published = true;
    return {
      number: 2,
      html_url: "https://github.com/fixture/observer/pull/2",
    };
  };
  line.notify = async () => {};
  let liveThread = false,
    liveCommand = false;
  const timer = setInterval(() => {
    void db
      .one(
        `SELECT EXISTS(SELECT 1 FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=$1 AND r.completed_at IS NULL AND e.kind='thread') AS thread,
      EXISTS(SELECT 1 FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=$1 AND r.completed_at IS NULL AND e.kind='command_end') AS command`,
        [task.id],
      )
      .then((r) => {
        liveThread ||= r.thread;
        liveCommand ||= r.command;
      });
  }, 500);
  try {
    await new Execution(db, gh, line, new Budget(db), runner).execute(task.id);
  } finally {
    clearInterval(timer);
  }
  const result = await db.one(
    "SELECT * FROM runs WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1",
    [task.id],
  );
  runId = result.id;
  assert.equal(result.outcome, "ready");
  assert(published);
  assert(liveThread, "執行中應取得真實 thread ID");
  assert(liveCommand, "執行中應取得命令結果");
  app = await buildApp(db);
  const session = randomUUID();
  await db.query(
    "INSERT INTO sessions VALUES($1,$2,'驗收用',now()+interval '1 hour')",
    [hash(session), c.adminId],
  );
  const headers = { cookie: `af_session=${session}` };
  const response = await app.inject({
    url: `/api/tasks/${task.id}/runs/${runId}/events`,
    headers,
  });
  assert.equal(response.statusCode, 200);
  const events = response.json().events;
  assert(
    events.filter((e) => e.kind === "thread").length >= 2,
    "開發與獨立審查各有 thread ID",
  );
  assert(events.some((e) => e.kind === "container"));
  assert(events.some((e) => e.kind === "command_end"));
  assert(!response.body.includes('"auth":'));
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  assert.equal(detail.runs[0].threads.length, 2);
  assert(!("result" in detail.runs[0]));
  await mkdir(".local", { recursive: true });
  const proof = {
    taskId: task.id,
    runId,
    liveThread,
    liveCommand,
    events: events.length,
    threads: detail.runs[0].threads,
    outcome: result.outcome,
    startedAt: result.started_at,
    completedAt: result.completed_at,
  };
  await writeFile(".local/observer-proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  if (runId) await runner.call("dispose", { runId });
  await app?.close();
  await db.close();
}
