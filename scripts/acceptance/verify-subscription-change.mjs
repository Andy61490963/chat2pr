import { fork } from "node:child_process";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const script = fileURLToPath(import.meta.url);
const approved = process.argv.slice(2).join(" ") === "--approve-fixture-v1";
const file = "demo-title.txt";
const before = "範例清單\n";
const after = "示範清單\n";
const summary = "只修改 demo-title.txt，將唯一一行「範例清單」改為「示範清單」，保留行尾換行，不新增其他檔案。";
const result = {
  狀態: "未開始", 任務狀態: null, 上游類別: null, 上游狀態碼: null,
  修改推論已確認: false, 審查推論已確認: false, 僅修改指定虛構檔案: null,
};

function requireMatch(condition) {
  if (!condition) throw new Error("驗收條件不符");
}

function matchesFixture(files) {
  return Array.isArray(files) && files.length === 1 && files[0]?.path === file &&
    files[0].mode === "100644" && files[0].content === Buffer.from(after).toString("base64");
}

function environment(env) {
  const instance = env.AGENTFLOW_INSTANCE;
  requireMatch(/^verify-264-[a-z0-9][a-z0-9-]{0,40}$/.test(instance ?? ""));
  const ports = [env.RUNNER_LISTEN_PORT, env.SUBSCRIPTION_BROKER_PORT, env.ACCEPTANCE_DB_PORT];
  requireMatch(ports.join("/") === "24312/24313/25439");
  const runnerUrl = `http://127.0.0.1:${ports[0]}`;
  requireMatch(!env.RUNNER_URL || env.RUNNER_URL === runnerUrl);
  requireMatch(!env.ACCEPTANCE_SUBSCRIPTION_BROKER_PORT || env.ACCEPTANCE_SUBSCRIPTION_BROKER_PORT === ports[1]);
  const url = new URL(env.DATABASE_URL);
  requireMatch(["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === "127.0.0.1" && url.port === ports[2] &&
    url.pathname === "/agentflow_a_test" && url.username === "agentflowtest" &&
    url.password && !url.search && !url.hash && !env.PGOPTIONS);
  const dir = fileURLToPath(new URL(`../../.local/acceptance/${instance}/`, import.meta.url));
  const secretPath = resolve(dir, "secrets.json");
  requireMatch(!env.SECRETS_FILE || resolve(env.SECRETS_FILE) === secretPath);
  requireMatch(/^(?:[a-z0-9][a-z0-9._/-]*:acceptance|sha256:[a-f0-9]{64})$/.test(env.ACCEPTANCE_WORKER_IMAGE ?? ""));
  Object.assign(env, {
    RUNNER_URL: runnerUrl, SECRETS_FILE: secretPath, DATA_DIR: resolve(dir, "data"),
    PUBLIC_URL: "http://fixture.invalid", ADMIN_GITHUB_ID: "",
  });
  return { instance, runnerUrl, databaseUrl: url.href, image: env.ACCEPTANCE_WORKER_IMAGE };
}

async function approveFixture(taskId, projectId) {
  const { databaseUrl, instance } = environment(process.env);
  const scratch = process.env.ACCEPTANCE_SCRATCH;
  requireMatch(scratch && isAbsolute(scratch) && basename(resolve(scratch)) === "codex-264" &&
    basename(dirname(resolve(scratch))) === "scratchpad");
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "oauth-"));
  const fixtureConfig = join(dir, "oauth.json");
  const clientId = "FixtureClient264", clientSecret = "FixtureSecret264";
  const code = randomBytes(20).toString("hex"), token = randomBytes(20).toString("hex");
  const member = String(264000000000 + randomInt(1000000000)), login = "示範審核者", origin = "http://fixture.invalid";
  let app, db, added, headers;
  try {
    await writeFile(fixtureConfig, JSON.stringify({ githubClientId: clientId, githubClientSecret: clientSecret }), { flag: "wx", mode: 0o600 });
    process.env.SECRETS_FILE = fixtureConfig;
    process.env.RUNNER_URL = origin;
    const { Database } = await import("../../server/db.ts");
    const { buildApp } = await import("../../server/app.ts");
    db = new Database(databaseUrl);
    requireMatch(await db.one("SELECT 1 FROM verify_subscription_264 WHERE instance=$1 AND initialized", [instance]));
    await db.query("INSERT INTO members(github_id,login,role) VALUES ($1,$2,'member')", [member, login]);
    added = true;
    let exchanged = false;
    globalThis.fetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token" && !exchanged && options.method === "POST") {
        const grant = JSON.parse(options.body);
        requireMatch(grant.code === code && grant.client_id === clientId && grant.client_secret === clientSecret &&
          grant.redirect_uri === origin + "/auth/github/callback");
        exchanged = true;
        return Response.json({ access_token: token });
      }
      requireMatch(exchanged && url === "https://api.github.com/user" && options.headers.Authorization === "Bearer " + token);
      return Response.json({ id: Number(member), login });
    };
    app = await buildApp(db);
    const url = "/api/tasks/" + taskId;
    requireMatch((await app.inject({ method: "POST", url: url + "/actions", payload: { action: "approve", version: 1 } })).statusCode === 401);
    const start = await app.inject({ url: "/auth/github", headers: { host: "fixture.invalid" } });
    const authorize = new URL(start.headers.location);
    const state = authorize.searchParams.get("state");
    const oauth = start.cookies.find(cookie => cookie.name === "af_oauth");
    requireMatch(start.statusCode === 302 && authorize.origin + authorize.pathname === "https://github.com/login/oauth/authorize" &&
      authorize.searchParams.get("client_id") === clientId && state && oauth?.value === state);
    const callbackUrl = "/auth/github/callback?" + new URLSearchParams({ state, code });
    requireMatch((await app.inject({ url: callbackUrl, cookies: { af_oauth: "WrongState264" } })).statusCode === 403);
    const callback = await app.inject({ url: callbackUrl, cookies: { af_oauth: oauth.value } });
    const session = callback.cookies.find(cookie => cookie.name === "af_session");
    requireMatch(callback.statusCode === 302 && session?.value);
    const cookie = "af_session=" + session.value;
    const me = (await app.inject({ url: "/api/me", headers: { cookie } })).json();
    requireMatch(me.id === member && me.role === "member" && !me.owner && me.csrf);
    headers = { cookie, origin, "x-csrf-token": me.csrf };
    const { task, projectReview } = (await app.inject({ url, headers })).json();
    requireMatch(task.status === "awaiting_approval" && task.version === 1 && task.summary === summary &&
      task.project_id === projectId && task.target_branch === "main" && task.group_id === task.dedupe_key &&
      /^verify-264-[0-9a-f-]{36}$/.test(task.group_id) && projectReview.repo === "fixture/" + task.group_id.slice("verify-264-".length) &&
      !task.risk_reasons.length);
    const action = { method: "POST", url: url + "/actions", payload: {
      action: "approve", version: task.version, project_id: projectId, target_branch: task.target_branch,
      config_version: projectReview.config_version, binding_version: projectReview.binding_version,
    } };
    requireMatch((await app.inject({ ...action, headers: { cookie, origin } })).statusCode === 403);
    requireMatch((await app.inject({ ...action, headers })).statusCode === 200);
  } finally {
    try {
      if (headers) requireMatch((await app.inject({ method: "POST", url: "/api/logout", headers })).statusCode === 200);
    } finally {
      try { if (added) await db.query("DELETE FROM members WHERE github_id=$1 AND role='member'", [member]); }
      finally {
        await app?.close();
        await db?.close();
        await unlink(fixtureConfig);
        await rmdir(dir);
      }
    }
  }
}

async function openFixtureDatabase(db, instance) {
  const lock = await db.pool.connect();
  try {
    const { rows: [identity] } = await lock.query(
      "SELECT current_database() AS db, current_user AS role, current_schema() AS schema, pg_try_advisory_lock(264,264) AS owned",
    );
    requireMatch(identity.db === "agentflow_a_test" && identity.role === "agentflowtest" &&
      identity.schema === "public" && identity.owned);
    const marker = await db.one("SELECT to_regclass('public.verify_subscription_264') AS name");
    if (!marker.name) {
      const { empty } = await db.one(
        "SELECT NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S')) AS empty",
      );
      requireMatch(empty);
      await db.transaction(async client => {
        await client.query("CREATE TABLE verify_subscription_264 (instance text PRIMARY KEY, initialized boolean NOT NULL DEFAULT false)");
        await client.query("INSERT INTO verify_subscription_264(instance) VALUES ($1)", [instance]);
      });
    }
    const owner = await db.one("SELECT initialized FROM verify_subscription_264 WHERE instance=$1", [instance]);
    requireMatch(owner);
    await db.migrate();
    if (!owner.initialized) await db.transaction(async client => {
      await client.query(`UPDATE settings SET value=value || '{"paused":false,"code_downloads":false}'::jsonb WHERE id=1 AND value->>'ai_mode'='subscription'`);
      await client.query("UPDATE verify_subscription_264 SET initialized=true WHERE instance=$1", [instance]);
    });
    const settings = await db.settings();
    requireMatch(settings.ai_mode === "subscription" && settings.container_network === "isolated" && !settings.paused);
    return lock;
  } catch (error) {
    lock.release(true);
    throw error;
  }
}

async function run() {
  result.狀態 = "隔離設定未通過";
  const settings = environment(process.env);
  const { HttpRunner, Execution } = await import("../../server/execution.ts");
  const { runnerRequest } = await import("../../server/runner-http.ts");
  const { acceptanceRunnerReady } = await import("./setup-config.ts");
  const { Database } = await import("../../server/db.ts");
  const { Budget } = await import("../../server/budget.ts");
  const { Tasks } = await import("../../server/tasks.ts");
  const { classifyRisk } = await import("../../server/policy.ts");
  const { statusLabels } = await import("../../shared/status-glossary.ts");
  const { parseUpstreamFailure } = await import("../../shared/upstream-failure.ts");
  const { pack } = await import("tar-stream");

  result.狀態 = "執行器身分未確認";
  const runner = new HttpRunner(undefined, async (address, options) => {
    if (address === settings.runnerUrl + "/health") {
      const ready = await acceptanceRunnerReady(settings.runnerUrl, options.headers["x-runner-key"], settings.instance, 10000);
      requireMatch(ready);
      return { status: 200, body: "{}" };
    }
    return runnerRequest(address, options);
  });
  await runner.call("health", {});
  runner.prepareSource = undefined;
  const call = runner.call.bind(runner);
  let cleanupFailed = false;
  runner.call = async (path, payload, ...rest) => {
    const inference = path === "phase" && ["code", "review"].includes(payload.phase);
    if (path === "phase") requireMatch(!payload.full && !payload.open);
    if (inference) requireMatch(payload.job?.mode === "subscription" && !payload.job.query);
    try {
      const response = await call(path, payload, ...rest);
      if (path === "phase" && payload.phase === "collect" && response.exitCode === 0)
        result.僅修改指定虛構檔案 = matchesFixture(JSON.parse(response.stdout).files);
      if (inference) {
        const failure = parseUpstreamFailure(response.upstreamFailure);
        if (failure && !result.上游類別) {
          result.上游類別 = failure.kind;
          result.上游狀態碼 = failure.status ?? null;
        }
        if (!failure && response.exitCode === 0 && response.upstreamSucceeded === true)
          result[payload.phase === "code" ? "修改推論已確認" : "審查推論已確認"] = true;
      }
      return response;
    } catch (error) {
      if (path === "dispose" || path === "cancel") cleanupFailed = true;
      throw error;
    }
  };

  const attempt = randomUUID();
  const group = `verify-264-${attempt}`;
  const repo = `fixture/${attempt}`;
  const sha = createHash("sha1").update(before).digest("hex");
  let published = false;
  const github = {
    base: async () => sha,
    archive: async (project, version) => {
      requireMatch(project.repo === repo && version === sha);
      const tar = pack();
      tar.entry({ name: "fixture/" + file, mode: 0o644 }, before);
      tar.finalize();
      const chunks = [];
      for await (const chunk of tar) chunks.push(chunk);
      return new Blob([gzipSync(Buffer.concat(chunks))]).stream();
    },
    ensureIssue: async () => ({ number: 1, url: "https://example.invalid/issues/1" }),
    findPr: async () => undefined,
    publish: async (project, task, files, _report, guard) => {
      await guard();
      requireMatch(!published && project.repo === repo && task.group_id === group &&
        task.base_sha === sha && matchesFixture(files));
      published = true;
      return { number: 1, html_url: "https://example.invalid/pull/1" };
    },
  };

  result.狀態 = "驗收資料庫未就緒";
  const db = new Database(settings.databaseUrl);
  let lock, task;
  try {
    lock = await openFixtureDatabase(db, settings.instance);
    const execution = new Execution(db, github, { notify: async () => {} }, new Budget(db), runner);
    const project = await db.one(
      "INSERT INTO projects(name,repo,image,install_command,test_command) VALUES ('示範清單',$1,$2,'true',$3) RETURNING *",
      [repo, settings.image, "grep -Exq '範例清單|示範清單' demo-title.txt && test \"$(wc -l < demo-title.txt)\" -eq 1"],
    );
    result.狀態 = "專案驗證未通過";
    await execution.validate(project);
    const validated = await db.one("SELECT enabled AND validated_at IS NOT NULL AS ok FROM projects WHERE id=$1", [project.id]);
    requireMatch(validated.ok && !cleanupFailed);

    result.狀態 = "核准未通過";
    requireMatch(!classifyRisk(summary, [], [file], project.sensitive_paths));
    task = await db.transaction(async client => {
      await client.query("INSERT INTO groups(id,name,enabled) VALUES ($1,'示範驗收群',true)", [group]);
      await client.query("INSERT INTO group_projects(group_id,project_id) VALUES ($1,$2)", [group, project.id]);
      return (await client.query(
        "INSERT INTO tasks(group_id,project_id,title,summary,acceptance,dedupe_key) VALUES ($1,$2,'調整示範清單',$3,$4,$1) RETURNING id,version",
        [group, project.id, summary, JSON.stringify(["僅指定檔案含有新標題與行尾換行"])],
      )).rows[0];
    });
    await new Promise((done, fail) => {
      const child = quietChild({
        ...Object.fromEntries(["SystemRoot", "PATH", "TEMP", "TMP", "AGENTFLOW_INSTANCE", "RUNNER_LISTEN_PORT",
          "SUBSCRIPTION_BROKER_PORT", "ACCEPTANCE_DB_PORT", "DATABASE_URL", "ACCEPTANCE_WORKER_IMAGE", "ACCEPTANCE_SCRATCH"]
          .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
        VERIFY264_OAUTH_TASK: task.id, VERIFY264_OAUTH_PROJECT: project.id,
      });
      child.once("error", fail);
      child.once("close", status => status === 0 ? done() : fail(new Error("驗收登入或核准未通過")));
    });

    result.狀態 = "修改驗收未通過";
    await execution.execute(task.id);
    const state = await db.one(
      "SELECT status, EXISTS(SELECT FROM runs WHERE task_id=$1 AND completed_at IS NOT NULL) AS finished FROM tasks WHERE id=$1",
      [task.id],
    );
    result.任務狀態 = Object.hasOwn(statusLabels, state.status) ? statusLabels[state.status] : null;
    requireMatch(state.status === "ready" && state.finished && published && !result.上游類別 &&
      result.修改推論已確認 && result.審查推論已確認 && result.僅修改指定虛構檔案);
  } finally {
    try {
      if (task) {
        const pending = await db.one(
          "SELECT version FROM tasks WHERE id=$1 AND group_id=$2 AND status IN ('queued','budget_wait')",
          [task.id, group],
        );
        if (pending) await new Tasks(db).action(task.id, "cancel", pending.version, "驗收清理");
      }
      requireMatch(!cleanupFailed);
    } catch (error) {
      result.狀態 = "本次工作未完成清理";
      throw error;
    } finally {
      lock?.release(true);
      await db.close();
    }
  }
  result.狀態 = "通過";
}

function quietChild(env) {
  return fork(script, ["--approve-fixture-v1"], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, env,
  });
}

if (!approved) {
  console.log(JSON.stringify({ ...result, 狀態: "須明確核准第一版虛構修改" }));
  process.exitCode = 1;
} else if (process.send && process.env.VERIFY264_OAUTH_TASK) {
  try { await approveFixture(process.env.VERIFY264_OAUTH_TASK, process.env.VERIFY264_OAUTH_PROJECT); }
  catch { process.exitCode = 1; }
} else if (process.send) {
  try { await run(); } catch { process.exitCode = 1; }
  process.send({ subscriptionChange264: result });
} else {
  const child = quietChild(process.env);
  let report;
  child.on("message", message => {
    if (message?.subscriptionChange264) report = message.subscriptionChange264;
  });
  child.once("error", () => { process.exitCode = 1; });
  child.once("close", code => {
    console.log(JSON.stringify(report ?? { ...result, 狀態: "驗收程序未完成" }));
    process.exitCode = code === 0 && report?.狀態 === "通過" ? 0 : 1;
  });
}
