// 隔離驗收：真實 pg-boss、BGE-M3、Codex 開發與獨立審查；GitHub 寫入與 LINE 傳送留在測試邊界。
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import sharp from "sharp";
import { Database } from "../server/db.ts";
import { config, secrets } from "../server/config.ts";
import { buildApp } from "../server/app.ts";
import { GitHub } from "../server/github.ts";
import { HttpRunner } from "../server/execution.ts";
import { HttpEmbedder } from "../server/embedder.ts";
import { startJobs } from "../server/jobs.ts";
const settings = config(),
  key = secrets();
assert(
  settings.instance.startsWith("verify-"),
  "驗收必須指定 AGENTFLOW_INSTANCE=verify-<suiteId>",
);
assert(
  new URL(settings.databaseUrl).pathname.endsWith("_flow_test"),
  "請提供專用的空白 _flow_test 資料庫",
);
assert(
  (key.runnerSecret || process.env.RAG_VERIFY_RUNNER_CONFIG) &&
    key.lineSecret &&
    key.githubWebhookSecret &&
    !key.lineToken &&
    !key.githubPrivateKey &&
    !key.openaiKey,
  "請提供驗收專用設定，只需要執行器憑證與虛構 Webhook 密鑰",
);
const db = new Database(settings.databaseUrl);
const group = "acceptance",
  repo = "fixture/site",
  worker = process.env.RAG_VERIFY_WORKER ?? "line-agentflow-worker:local";
const topic =
  "請把首頁 index.html 唯一的主標題從「每日清單」改成「今日工作清單」。保留現有內容，驗收條件是頁面上只有一個 h1，文字完全等於「今日工作清單」。沿用本專案先前的畫面驗證方式。";
async function until(label, read, timeout = 600000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value) {
      console.log("通過", label);
      return value;
    }
    await new Promise((r) => setTimeout(r, 2000));
  } while (Date.now() < end);
  throw Error(label + "逾時");
}
async function fixtureArchive(broken) {
  const tar = pack();
  const html =
    '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>工作台</title><h1>每日清單</h1><p>今天的工作</p></html>';
  tar.entry({ name: "repo/index.html" }, html);
  tar.entry(
    { name: "repo/prepare.sh" },
    broken
      ? "echo '截圖驗收失敗：375px 手機版缺少可驗證的 PNG 截圖。' >&2; exit 1"
      : "exit 0",
  );
  tar.finalize();
  const blocks = [];
  for await (const b of tar) blocks.push(b);
  return new Blob([gzipSync(Buffer.concat(blocks))]).stream();
}
const gh = new GitHub(),
  runner = new HttpRunner(() =>
    process.env.RAG_VERIFY_RUNNER_CONFIG
      ? JSON.parse(readFileSync(process.env.RAG_VERIFY_RUNNER_CONFIG, "utf8"))
          .runnerSecret
      : key.runnerSecret,
  );
const runnerKey = process.env.RAG_VERIFY_RUNNER_CONFIG
  ? JSON.parse(readFileSync(process.env.RAG_VERIFY_RUNNER_CONFIG, "utf8"))
      .runnerSecret
  : key.runnerSecret;
const runnerHealth = await fetch(settings.runnerUrl + "/health", {
  headers: { "x-runner-key": runnerKey },
  signal: AbortSignal.timeout(10000),
});
assert(runnerHealth.ok, "驗收 runner 無法連線");
assert.equal(
  (await runnerHealth.json()).instance,
  settings.instance,
  "禁止將驗收工作交給正式或其他套件 runner",
);
// 隔離驗收使用自建封存檔，不授予虛構儲存庫真實 GitHub 存取權。
runner.prepareSource = undefined;
let sha = "v1",
  issue = 0,
  pr = 0,
  hadScreenshot = false,
  previous;
gh.base = async () => sha;
gh.archive = async (_project, version) => fixtureArchive(version === "v1");
gh.context = async () => ({
  sha,
  paths: ["index.html", "prepare.sh"],
  files: {},
  truncated: false,
});
gh.ensureIssue = async (_p, t) => ({
  number: t.issue_number ?? ++issue,
  url: "https://example.invalid/issue",
});
gh.findPr = async () => undefined;
gh.publish = async (_p, _t, files, _report, guard) => {
  await guard();
  assert(
    files.some(
      (f) =>
        f.path === "index.html" &&
        Buffer.from(f.content, "base64").toString().includes("今日工作清單"),
    ),
  );
  for (const file of files.filter(
    (f) => f.path.endsWith(".png") && f.content,
  )) {
    const bytes = Buffer.from(file.content, "base64");
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: 20_000_000,
    });
    const meta = await image.metadata();
    assert.equal(meta.format, "png", "截圖必須是可解碼的 PNG");
    const decoded = await image.raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width === 375 && decoded.info.height >= 200)
      hadScreenshot = true;
  }
  assert(
    hadScreenshot,
    "必須發布可解碼的 375px 手機 PNG，模型提到截圖不算驗收",
  );
  return { number: ++pr, html_url: "https://example.invalid/pull/1" };
};
const observed = new Set();
const realCall = runner.call.bind(runner);
runner.call = async (path, payload, ...rest) => {
  if (path === "phase" && ["code", "review"].includes(payload.phase)) {
    const received = JSON.parse(payload.job.prompt).pastOutcomes;
    assert(
      received.some(
        (row) =>
          row.taskId === previous && row.summary.includes("截圖驗收失敗"),
      ),
      "開發或審查缺少歷史經驗",
    );
    observed.add(payload.phase);
  }
  const result = await realCall(path, payload, ...rest);
  if (path === "ai" && payload.job.kind === "triage") {
    assert(
      payload.job.prompt.includes('"relevantFiles"') &&
        payload.job.prompt.includes("一週前的舊對話樣本"),
      "判讀缺少檔案或舊對話",
    );
  }
  return result;
};
// 在 Windows 主機執行驗收時，從 app 容器發出模型請求，沿用正式環境的內網限制。
const model = process.env.RAG_VERIFY_APP
  ? {
      embed(texts) {
        return new Promise((resolve, reject) => {
          const child = spawn(
            "docker",
            [
              "exec",
              "-i",
              process.env.RAG_VERIFY_APP,
              "node",
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              "import {HttpEmbedder} from './server/embedder.ts';const b=[];for await(const s of process.stdin)b.push(s);console.log(JSON.stringify(await new HttpEmbedder().embed(JSON.parse(Buffer.concat(b).toString()))))",
            ],
            { stdio: ["pipe", "pipe", "ignore"] },
          );
          let out = "";
          child.stdout.on("data", (s) => (out += s));
          child.on("error", reject);
          child.on("close", (code) => {
            try {
              if (code) throw Error("模型連線失敗");
              resolve(JSON.parse(out));
            } catch (e) {
              reject(e);
            }
          });
          child.stdin.end(JSON.stringify(texts));
        });
      },
    }
  : new HttpEmbedder();
let jobs, app;
try {
  const existing = await db.one("SELECT to_regclass('public.tasks') AS name");
  assert(!existing.name, "驗收需要全新的資料庫");
  await db.migrate();
  await db.migrate();
  await db.query(
    'UPDATE settings SET value=value || \'{"rag_enabled":true,"paused":false,"ai_mode":"subscription","coding_effort":"medium"}\'',
  );
  const project = await db.one(
    "INSERT INTO projects(name,repo,image,install_command,test_command,enabled,validated_at) VALUES('驗收網站',$1,$2,'sh prepare.sh','grep -q h1 index.html',true,now()) RETURNING id",
    [repo, worker],
  );
  await db.query(
    "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES($1,'隔離驗收群',true,'auto')",
    [group],
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES($1,$2)",
    [group, project.id],
  );
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,processed,received_at) VALUES('history',$1,'text','一週前的舊對話樣本：首頁清單給手機使用者閱讀。',true,now()-interval '7 days')",
    [group],
  );
  previous = (
    await db.one(
      "INSERT INTO tasks(group_id,project_id,title,summary,status,approved_version,dedupe_key) VALUES($1,$2,'上週庫存頁改色','修正庫存頁手機排版','queued',1,'fixture-history') RETURNING id",
      [group, project.id],
    )
  ).id;
  app = await buildApp(db);
  jobs = await startJobs(db, { github: gh, runner, model });
  await until("舊任務真實執行失敗並由背景工作建立結果向量", () =>
    db.one(
      "SELECT 1 FROM embeddings WHERE kind='outcome' AND ref_id=$1 AND content LIKE '%截圖驗收失敗%'",
      [previous],
    ),
  );
  sha = "v2";
  const body = JSON.stringify({
    events: [
      {
        webhookEventId: "flow-event",
        type: "message",
        source: { type: "group", groupId: group },
        message: { type: "text", id: "flow-msg", text: topic },
      },
    ],
  });
  const line = {
    method: "POST",
    url: "/webhooks/line",
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", key.lineSecret)
        .update(body)
        .digest("base64"),
    },
    payload: body,
  };
  assert.equal((await app.inject(line)).statusCode, 200);
  assert.equal((await app.inject(line)).statusCode, 200);
  const current = await until("新訊息經背景判讀建立一個需求", () =>
    db.one("SELECT * FROM tasks WHERE 'flow-msg'=ANY(source_ids)"),
  );
  if (current.status === "awaiting_approval") {
    await db.query(
      "INSERT INTO sessions VALUES($1,$2,'flow-csrf',now()+interval '1 hour')",
      [
        createHash("sha256").update("flow-test").digest("hex"),
        settings.adminId,
      ],
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks/" + current.id + "/actions",
      headers: {
        origin: settings.publicUrl,
        cookie: "af_session=flow-test",
        "x-csrf-token": "flow-csrf",
      },
      payload: { action: "approve", version: current.version },
    });
    assert.equal(r.statusCode, 200);
  }
  await until(
    "真實 Codex 修改、測試、獨立審查與候選檔案發布",
    async () => {
      const t = await db.one(
        "SELECT status,last_error FROM tasks WHERE id=$1",
        [current.id],
      );
      if (t.status === "failed") throw Error("執行失敗：" + t.last_error);
      return t.status === "ready";
    },
    1200000,
  );
  assert.deepEqual([...observed].sort(), ["code", "review"]);
  assert(hadScreenshot, "未取得實體截圖產物");
  const payload = JSON.stringify({
    repository: { full_name: repo },
    pull_request: { number: pr, state: "closed", merged: true },
  });
  const github = {
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "flow-merged",
      "x-hub-signature-256":
        "sha256=" +
        createHmac("sha256", key.githubWebhookSecret)
          .update(payload)
          .digest("hex"),
    },
    payload,
  };
  assert.equal((await app.inject(github)).statusCode, 200);
  assert.equal((await app.inject(github)).statusCode, 200);
  await until("合併 Webhook 回寫同一筆結果經驗", () =>
    db.one(
      "SELECT 1 FROM embeddings WHERE kind='outcome' AND ref_id=$1 AND content LIKE '%狀態：已合併%'",
      [current.id],
    ),
  );
  assert.equal(
    (
      await db.one(
        "SELECT count(*)::int n FROM tasks WHERE 'flow-msg'=ANY(source_ids)",
      )
    ).n,
    1,
  );
  const notifications = await db.query(
    "SELECT kind FROM notifications WHERE (task_id=$1 AND kind='failed') OR (task_id=$2 AND kind='ready') ORDER BY kind",
    [previous, current.id],
  );
  assert.deepEqual(
    notifications.map((row) => row.kind),
    ["failed", "ready"],
  );
  assert.equal(pr, 1);
  console.log(
    "完成驗收",
    JSON.stringify({
      實際截圖: hadScreenshot,
      驗證邊界: "隔離背景流程與可解碼 PNG；畫面內容仍須獨立瀏覽器驗收",
      發布次數: pr,
    }),
  );
} finally {
  await jobs?.stop();
  await app?.close();
  await db.close();
}
