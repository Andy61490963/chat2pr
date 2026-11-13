import { ObservationBuffer } from "./observation.js";
import Fastify from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Containers } from "./containers.js";
import { systemStatus } from "./system-status.js";
import { hostResources } from "./host-resources.js";
import { SourceCache, SourceAccess } from "./source-cache.js";
import { readCodexAccount, type CodexAccount } from "./codex-account.js";
import {
  secrets,
  validateRunnerEnvironment,
  subscriptionBrokerPort,
} from "./config.js";
import { AppError } from "./policy.js";
import { SubscriptionBroker } from "./subscription-broker.js";
import { subscriptionIdentity } from "./subscription-identity.js";
import {
  CaptureInput,
  captureSnapshot,
  runCheckQuery,
  testConnection,
} from "./database-capture.js";
import { cleanupDocker } from "./docker-cleanup.js";
import { httpProbe, tcpProbe } from "./check-probes.js";
// 必須在任何 Docker 操作（尤其啟動清理）以前拒絕不完整的隔離設定。
validateRunnerEnvironment();
const app = Fastify({ logger: false, bodyLimit: 80 * 1024 * 1024 });
const containers = new Containers();
const sourceCache = new SourceCache(containers);
const observations = new ObservationBuffer();
// 訂閱登入只存在可信主機；工作容器、應用程式、資料庫及日誌都不取得登入檔。
// 不放在 .local：該目錄會唯讀掛載進應用程式容器。
const codexHome = resolve(process.env.CODEX_SERVICE_HOME ?? ".codex-service");
const authFile = join(codexHome, "auth.json");
const broker = new SubscriptionBroker({
  credentials: subscriptionIdentity(codexHome),
});
const brokerApp = Fastify({ logger: false });
brokerApp.setErrorHandler((err, _req, reply) => {
  const e =
    err instanceof AppError ? err : new AppError(400, "訂閱代理請求無效");
  reply.code(e.statusCode).send({ error: { message: e.message } });
});
broker.register(brokerApp);
const Job = z.object({
  runId: z.string().uuid(),
  image: z.string().min(1).max(200),
});
type AiJob = Record<string, unknown> & { mode?: string };
async function withCapability<T>(
  runId: string,
  phase: string,
  job: AiJob | undefined,
  timeoutMs: number,
  execute: (job: AiJob | undefined, remaining: number) => Promise<T>,
) {
  if (job && Object.hasOwn(job, "auth"))
    throw new AppError(400, "工作不得攜帶主訂閱憑證");
  if (job?.mode !== "subscription") return execute(job, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const capability = await broker.issue({
    runId,
    phase,
    model: typeof job.model === "string" ? job.model : undefined,
    deadline,
  });
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError(408, "訂閱階段已超過期限");
    return await execute(
      {
        ...job,
        token: capability.token,
        model: capability.model,
        proxyUrl: `${process.env.SUBSCRIPTION_RELAY_URL ?? "http://subscription-relay:4313"}${capability.basePath}`,
        timeoutMs: Math.min(Number(job.timeoutMs) || remaining, remaining),
      },
      remaining,
    );
  } finally {
    capability.revoke();
  }
}
const aiNetwork = (job: AiJob | undefined) =>
  job?.mode === "subscription"
    ? "line-agentflow_subscription"
    : "line-agentflow_workers";
app.addHook("onRequest", async (req) => {
  const key = secrets().runnerSecret,
    received = String(req.headers["x-runner-key"] ?? "");
  if (
    !key ||
    received.length !== key.length ||
    !timingSafeEqual(Buffer.from(key), Buffer.from(received))
  )
    throw new AppError(401, "執行器授權失敗");
});
app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
  done(null, payload),
);
app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  reply.code(e.statusCode ?? 500).send({ error: e.message.slice(0, 2000) });
});
app.get("/health", async () => {
  await containers.docker.ping();
  return { ok: true, instance: containers.instance, subscriptionBroker: "v1" };
});
// 看板「系統」頁：服務容器、工作容器與工作映像狀態。
app.get("/system", async () =>
  systemStatus(containers.docker, containers.instance),
);
// 派工前的主機資源檢查與系統頁的同時執行數建議（#21）。
app.post("/resources", async () => hostResources(containers.docker));
app.get("/codex/status", async () => {
  if (!existsSync(authFile)) return { loggedIn: false };
  const auth = JSON.parse(readFileSync(authFile, "utf8"));
  return {
    loggedIn: !!auth.tokens || !!auth.OPENAI_API_KEY,
    method: auth.tokens ? "chatgpt" : "apikey",
  };
});
// 額度與模型清單：快取 60 秒，避免看板頻繁重新整理時反覆啟動 app-server。
let account: { at: number; data: CodexAccount } | undefined;
app.get("/codex/account", async (req) => {
  if (!existsSync(authFile))
    throw new AppError(
      503,
      "服務的 Codex 尚未登入，請執行 npm run codex:login",
    );
  const fresh = (req.query as { fresh?: string }).fresh === "1";
  if (!account || fresh || Date.now() - account.at > 60000)
    account = { at: Date.now(), data: await readCodexAccount(codexHome) };
  return account.data;
});
app.post("/prepare", async (req) => {
  const q = Job.parse(req.query);
  if (!req.headers["content-type"]?.startsWith("application/octet-stream"))
    throw new AppError(415, "請以串流上傳專案封存檔");
  await containers.prepare(q.runId, q.image, req.body as NodeJS.ReadableStream);
  return { ok: true };
});
app.post("/prepare-source", async (req) => {
  const b = Job.extend({
    source: SourceAccess,
    timeoutMs: z.number().int().min(1000).max(1800000),
  }).parse(req.body);
  const report = await sourceCache.prepare(
    b.runId,
    b.image,
    b.source,
    b.timeoutMs,
  );
  observations.add(b.runId, "archive", {
    kind: "phase_end",
    detail: `專案快取：${{ cold: "首次下載", hit: "命中", updated: "增量更新" }[report.cache]}；抓取 ${(report.fetchMs / 1000).toFixed(1)} 秒、快照 ${(report.snapshotMs / 1000).toFixed(1)} 秒、獨立副本 ${(report.copyMs / 1000).toFixed(1)} 秒`,
  });
  return report;
});
// 擁有者提供的環境資料（資料庫結構快照）：寫進這次執行專用的唯讀資料卷。
app.post("/environment-files", async (req) => {
  const b = Job.extend({
    files: z
      .array(
        z.object({
          path: z
            .string()
            .max(200)
            .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/),
          content: z.string(),
        }),
      )
      .min(1)
      .max(20),
  }).parse(req.body);
  await containers.provide(b.runId, b.image, b.files);
  return { ok: true };
});
// 跨專案查詢：其他被指名專案的原始碼封存，解開在環境資料卷的 projects/<名稱>，唯讀掛載。
app.post("/environment-archive", async (req) => {
  const q = Job.extend({
    directory: z
      .string()
      .max(200)
      .regex(/^projects\/[A-Za-z0-9._-]+$/)
      .refine((d) => !d.includes("..")),
  }).parse(req.query);
  if (!req.headers["content-type"]?.startsWith("application/octet-stream"))
    throw new AppError(415, "請以串流上傳專案封存檔");
  await containers.provideArchive(
    q.runId,
    q.image,
    q.directory,
    req.body as NodeJS.ReadableStream,
  );
  return { ok: true };
});
// 只有主機執行器接觸擁有者登記的資料庫；工作容器不取得連線機密。
app.post("/database/test", async (req) =>
  testConnection(CaptureInput.parse(req.body)),
);
app.post("/database/snapshot", async (req) =>
  captureSnapshot(CaptureInput.parse(req.body)),
);
// 定期檢查：唯讀 SQL、HTTP 與 TCP 探測只在主機執行；結果回給應用程式判定。
app.post("/checks/sql", async (req) => {
  const b = z
    .object({ connection: CaptureInput, sql: z.string().min(1).max(4000) })
    .parse(req.body);
  return { rows: await runCheckQuery(b.connection, b.sql) };
});
app.post("/checks/http", async (req) => {
  const b = z
    .object({
      url: z.string().url().max(2000),
      contains: z.string().max(200).optional(),
    })
    .parse(req.body);
  return httpProbe(b.url, b.contains);
});
app.post("/checks/tcp", async (req) => {
  const b = z
    .object({
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65535),
    })
    .parse(req.body);
  return tcpProbe(b.host, b.port);
});
// 每天由應用程式的維護工作呼叫；只有正式實例清理，驗收實例共用同一個 Docker 時不動手。
app.post("/maintenance/docker", async (req) => {
  const { keep } = z
    .object({ keep: z.array(z.string().min(1).max(200)).max(200) })
    .parse(req.body);
  if (containers.instance !== "production") return { skipped: true };
  return cleanupDocker(containers.docker, { keep });
});
app.post("/observations", async (req) => {
  const b = z
    .object({
      runId: z.string().uuid(),
      after: z.number().int().min(0).default(0),
    })
    .parse(req.body);
  return observations.read(b.runId, b.after);
});
app.post("/phase", async (req) => {
  const b = Job.extend({
    phase: z.enum(["install", "test", "code", "review", "collect"]),
    command: z.string().max(8000).optional(),
    open: z.boolean().optional(),
    job: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(1800000),
  }).parse(req.body);
  const observe = (e: Parameters<ObservationBuffer["add"]>[2]) =>
    observations.add(b.runId, b.phase, e);
  const ai = b.phase === "code" || b.phase === "review";
  const command = ai
    ? ["node", "/opt/agentflow/run.mjs"]
    : b.phase === "collect"
      ? ["node", "/opt/agentflow/collect.mjs"]
      : ["sh", "-c", b.command ?? "exit 1"];
  try {
    const result = await withCapability(
      b.runId,
      b.phase,
      b.job,
      b.timeoutMs,
      (job, remaining) =>
        containers.phase(
          b.runId,
          b.image,
          command,
          ai
            ? aiNetwork(b.job)
            : b.phase === "install"
              ? "line-agentflow_install"
              : b.phase === "test" && b.open === true
                ? "line-agentflow_open"
                : "none",
          ai ? JSON.stringify(job) : undefined,
          remaining,
          b.phase === "review",
          true,
          observe,
          {
            ...(b.phase === "collect" ||
            (b.phase === "code" && b.job?.query === true)
              ? { output: "collect" as const }
              : {}),
            ...(b.phase === "install" ? { nugetFeed: true } : {}),
            ...(ai && b.open === true
              ? { extraNetworks: ["line-agentflow_open"] }
              : b.phase === "code" && b.job?.packages === true
                ? { extraNetworks: ["line-agentflow_install"] }
                : {}),
          },
        ),
    );
    observe({
      kind: "phase_end",
      exitCode: result.exitCode,
      detail:
        b.phase === "install" || b.phase === "test"
          ? result.stdout.slice(-4000) + "\n" + result.stderr.slice(-2000)
          : result.stderr.slice(-4000),
    });
    return { ...result, observations: observations.read(b.runId) };
  } catch (e) {
    observe({
      kind: "error",
      detail: e instanceof Error ? e.message : "執行器階段失敗",
    });
    throw e;
  }
});
// 需求辨識：不掛載任何儲存庫的一次性容器。
app.post("/environment", async (req) => {
  const { image } = z
    .object({ image: z.string().min(1).max(200) })
    .parse(req.body);
  // 固定唯讀探測，不接受呼叫者命令、不掛載專案、不開網路。
  return containers.phase(
    randomUUID(),
    image,
    [
      "sh",
      "-c",
      'for tool in node python3 dotnet redis-server psql sqlite3; do if command -v "$tool" >/dev/null 2>&1; then printf \'%s\\n\' "$tool"; fi; done; for tool in /opt/mssql/bin/sqlservr /opt/mssql-tools18/bin/sqlcmd; do if test -x "$tool"; then printf \'%s\\n\' "$tool"; fi; done',
    ],
    "none",
    undefined,
    20000,
    false,
    false,
  );
});
app.post("/ai", async (req) => {
  const b = z
    .object({
      image: z.string().min(1).max(200),
      job: z.record(z.string(), z.unknown()),
      timeoutMs: z.number().int().min(1000).max(600000),
    })
    .parse(req.body);
  const runId = randomUUID();
  try {
    return await withCapability(
      runId,
      "triage",
      b.job,
      b.timeoutMs,
      (job, remaining) =>
        containers.phase(
          runId,
          b.image,
          ["node", "/opt/agentflow/run.mjs"],
          aiNetwork(b.job),
          JSON.stringify(job),
          remaining,
          false,
          false,
        ),
    );
  } finally {
    broker.revoke(runId);
  }
});
app.post("/cancel", async (req) => {
  const { runId } = z.object({ runId: z.string().uuid() }).parse(req.body);
  broker.revoke(runId);
  observations.forget(runId);
  await containers.cancel(runId);
  return { ok: true };
});
app.post("/dispose", async (req) => {
  const { runId } = z.object({ runId: z.string().uuid() }).parse(req.body);
  broker.revoke(runId);
  await containers.dispose(runId);
  observations.forget(runId);
  return { ok: true };
});
await containers.cleanup();
const listenPort = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.RUNNER_LISTEN_PORT ?? 4312);
const brokerPort = subscriptionBrokerPort();
await brokerApp.listen({ port: brokerPort, host: "127.0.0.1" });
app.addHook("onClose", async () => {
  broker.close();
  await brokerApp.close();
});
await app.listen({ port: listenPort, host: "127.0.0.1" });
console.log(`隔離執行器已啟動：http://127.0.0.1:${listenPort}`);
