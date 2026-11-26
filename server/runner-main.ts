import { maskCredentials } from "../shared/credentials.js";
import { ObservationBuffer, safeDetail } from "./observation.js";
import { registerRunnerSecrets } from "./runner-secrets.js";
import { registerRunnerAuth } from "./runner-auth.js";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Containers, candidatePath } from "./containers.js";
import { FULL_ACCESS_ENV } from "./containers.js";
import { ProbeTargets, probeTargets } from "./network-probe.js";
import { SshLoginInput, testSshLogin } from "./ssh-login.js";
import { systemStatus } from "./system-status.js";
import { hostResources } from "./host-resources.js";
import { SourceCache, SourceAccess } from "./source-cache.js";
import { readCodexAccount, type CodexAccount } from "./codex-account.js";
import {
  validateRunnerEnvironment,
  subscriptionBrokerPort,
} from "./config.js";
import { replyRunnerError } from "./error-reply.js";
import { AppError } from "./policy.js";
import { SubscriptionBroker } from "./subscription-broker.js";
import { subscriptionIdentity } from "./subscription-identity.js";
import {
  CaptureInput,
  captureSnapshot,
  testConnection,
} from "./database-capture.js";
import {
  cleanupDocker,
  diskSpace,
  dockerDataPath,
  dockerDiskInventory,
  removeDiskItems,
} from "./docker-cleanup.js";
import { httpEndpoint, safeHost } from "./check-probes.js";
import { CheckEnvironments, viaHostGateway } from "./check-environments.js";
import { assertReadOnlySelect } from "../shared/checks.js";
import { checkEnvironmentLimits } from "../shared/check-environment.js";
import {
  MAX_COLLECT_EXCLUDES,
  validCollectExclude,
} from "../shared/build-output.js";
import { applyEgress } from "./egress.js";
import { derivedImage } from "./derived-image.js";
import { assertTestsFound } from "./project-setup.js";
import { phaseEndEvents } from "./test-failures.js";
import { ENVIRONMENT_EXIT, testEnvironment } from "./sqlserver-test.js";
import {
  MAX_EGRESS_DOMAINS,
  MAX_INSTALL_COMMANDS,
  MAX_INSTALL_COMMAND_LENGTH,
  MAX_INSTALL_ITEMS,
} from "../shared/install-plan.js";
// 必須在任何 Docker 操作（尤其啟動清理）以前拒絕不完整的隔離設定。
validateRunnerEnvironment();
const app = Fastify({ logger: false, bodyLimit: 80 * 1024 * 1024 });
const containers = new Containers();
const sourceCache = new SourceCache(containers);
const checkEnvironments = new CheckEnvironments(containers);
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
async function withCapability<T extends { exitCode: number }>(
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
    onRetry: phase === "code" || phase === "review"
      ? (event) => observations.add(runId, phase, event)
      : undefined,
  });
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError(408, "訂閱階段已超過期限");
    const result = await execute(
      {
        ...job,
        token: capability.token,
        model: capability.model,
        proxyUrl: `${process.env.SUBSCRIPTION_RELAY_URL ?? "http://subscription-relay:4313"}${capability.basePath}`,
        timeoutMs: Math.min(Number(job.timeoutMs) || remaining, remaining),
      },
      remaining,
    );
    const failure =
      result.exitCode !== 0 && (phase === "code" || phase === "review")
        ? capability.failure()
        : undefined;
    return failure ? { ...result, upstreamFailure: failure } : result;
  } finally {
    capability.revoke();
  }
}
const aiNetwork = (job: AiJob | undefined) =>
  job?.mode === "subscription"
    ? "line-agentflow_subscription"
    : "line-agentflow_workers";
registerRunnerAuth(app);
app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
  done(null, payload),
);
app.setErrorHandler(replyRunnerError);
registerRunnerSecrets(app);
app.get("/health", async () => {
  await containers.docker.ping();
  return { ok: true, instance: containers.instance, subscriptionBroker: "v1" };
});
// 只確認執行器程序有回應，不碰 Docker：`/system` 逾時時，系統頁靠它分辨「執行器沒回應」與「Docker 沒回應」。
// 一樣經過上面的 x-runner-key 驗證。
app.get("/alive", async () => ({ ok: true }));
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
// 接續上一次執行：把伺服器保存的候選修改寫回剛準備好的工作副本（#241）。
app.post("/apply-candidate", async (req) => {
  const b = Job.extend({
    files: z
      .array(
        z.object({
          path: z.string().refine(candidatePath, "候選檔案路徑無效"),
          content: z.string().base64().nullable(),
          mode: z.enum(["100644", "100755"]),
        }),
      )
      .min(1)
      .max(5000),
    timeoutMs: z.number().int().min(1000).max(1800000),
  }).parse(req.body);
  await containers.applyCandidate(b.runId, b.image, b.files, b.timeoutMs);
  return { ok: true };
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
// 專案資訊中提到的位址：從這台主機實測連不連得到（連不到通常代表要先接上 VPN）。
app.post("/network/probe", async (req) =>
  probeTargets(ProbeTargets.parse((req.body as { targets?: unknown }).targets)),
);
// 專案登記的 SSH 主機：從這台主機實際登入一次，回報主機金鑰指紋。
app.post("/ssh/test", async (req) =>
  testSshLogin(SshLoginInput.parse(req.body)),
);
app.post("/database/test", async (req) =>
  testConnection(CaptureInput.parse(req.body)),
);
app.post("/database/snapshot", async (req) =>
  captureSnapshot(CaptureInput.parse(req.body)),
);
// 定期檢查（#19）：每個檢查在自己的檢查容器執行，網路只通到該檢查的目標；結果回給應用程式判定。
const CheckPolicy = z.object({
  idleMinutes: z
    .number()
    .int()
    .min(checkEnvironmentLimits.idleMinutes.min)
    .max(checkEnvironmentLimits.idleMinutes.max),
  max: z
    .number()
    .int()
    .min(checkEnvironmentLimits.max.min)
    .max(checkEnvironmentLimits.max.max),
});
const CheckRef = {
  checkId: z.string().uuid(),
  key: z.string().regex(/^[A-Za-z0-9.]{1,100}$/),
  policy: CheckPolicy,
};
const CheckRun = z.discriminatedUnion("kind", [
  z.object({
    ...CheckRef,
    kind: z.literal("sql"),
    connection: CaptureInput,
    sql: z.string().min(1).max(4000),
  }),
  z.object({
    ...CheckRef,
    kind: z.literal("http"),
    url: z.string().url().max(2000),
    contains: z.string().max(200).optional(),
  }),
  z.object({
    ...CheckRef,
    kind: z.literal("tcp"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
  }),
]);
app.post("/checks/run", async (req) => {
  const b = CheckRun.parse(req.body);
  if (b.kind === "sql") {
    const problem = assertReadOnlySelect(b.sql);
    if (problem) throw new AppError(422, problem);
    const first = b.connection.ssh ?? b.connection;
    const { result, created, removed } = await checkEnvironments.run(
      {
        checkId: b.checkId,
        key: b.key,
        kind: "sql",
        target: { host: viaHostGateway(first.host), port: first.port },
        init: { connection: b.connection },
      },
      { sql: b.sql },
      b.policy,
    );
    return { result, environment: { created, removed } };
  }
  // HTTP／TCP 目標先在主機核對一次，轉接器每次連線再核對解析結果。
  const target =
    b.kind === "http" ? httpEndpoint(b.url) : { host: b.host, port: b.port };
  await safeHost(target.host);
  const { result, created, removed } = await checkEnvironments.run(
    { checkId: b.checkId, key: b.key, kind: b.kind, target, init: {} },
    b.kind === "http" ? { url: b.url, contains: b.contains } : {},
    b.policy,
  );
  return { result, environment: { created, removed } };
});
app.post("/checks/environments", async () => ({
  environments: checkEnvironments.list(),
  failures: checkEnvironments.failureList(),
}));
// 應用程式定期送來目前有效的檢查與環境鍵；清單外、閒置逾時或超過上限的環境立即清除。
app.post("/checks/environments/sync", async (req) => {
  const b = z
    .object({
      valid: z
        .array(z.object({ checkId: z.string().uuid(), key: CheckRef.key }))
        .max(5000),
      policy: CheckPolicy,
    })
    .parse(req.body);
  const removed = await checkEnvironments.sync(
    new Map(b.valid.map((v) => [v.checkId, v.key])),
    b.policy,
  );
  return { removed };
});
app.post("/checks/environments/remove", async (req) => {
  const { checkId } = z.object({ checkId: z.string().uuid() }).parse(req.body);
  const existed = checkEnvironments.list().some((e) => e.checkId === checkId);
  await checkEnvironments.remove(checkId);
  return { removed: existed };
});
// 每天由應用程式的維護工作呼叫；只有正式實例清理，驗收實例共用同一個 Docker 時不動手。
app.post("/maintenance/docker", async (req) => {
  const { keep } = z
    .object({ keep: z.array(z.string().min(1).max(200)).max(200) })
    .parse(req.body);
  if (containers.instance !== "production") return { skipped: true };
  return cleanupDocker(containers.docker, { keep });
});
// 每小時的空間提醒只需要可用空間，不跑 docker system df。
app.post("/maintenance/disk/space", async () => ({
  space: await diskSpace(dockerDataPath(), "主機磁碟（Docker 資料所在）"),
}));
// 看板「系統」頁的 Docker 磁碟盤點；任何實例都可以讀。
app.post("/maintenance/disk/inventory", async () =>
  dockerDiskInventory(containers.docker, containers.instance),
);
// 依應用程式算出的清單刪除，但每一項都在這裡重新核對歸屬；驗收實例共用 Docker 時不動手。
app.post("/maintenance/disk/remove", async (req) => {
  const b = z
    .object({
      keep: z.array(z.string().min(1).max(200)).max(200),
      items: z
        .array(
          z.object({
            kind: z.enum(["image", "container", "volume", "build_cache"]),
            target: z.string().min(1).max(300),
            runId: z.string().uuid().optional(),
          }),
        )
        .max(1000),
    })
    .parse(req.body);
  if (containers.instance !== "production")
    return { skipped: true, removed: [], failed: [], cacheBytes: 0 };
  return removeDiskItems(containers, b.items, b.keep);
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
const Domains = z.array(z.string().max(253)).max(MAX_EGRESS_DOMAINS);
// 看板「系統」頁的下載來源白名單；寫進本實例的 egress 並重新載入。
app.post("/egress", async (req) => {
  const b = z.object({ domains: Domains }).parse(req.body);
  return applyEgress(containers, b.domains);
});
/** 用到套件出口前先同步白名單；代理還是舊版時記一筆說明，沿用映像內建的預設清單。 */
async function syncEgress(
  domains: string[] | undefined,
  observe: (e: Parameters<ObservationBuffer["add"]>[2]) => void,
) {
  if (!domains) return;
  try {
    await applyEgress(containers, domains);
  } catch (e) {
    observe({
      kind: "message",
      detail: `下載來源白名單未能更新，沿用代理目前的清單：${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
// 安裝前審查放行的系統套件：以 root 安裝成專案衍生映像，已有相同的就直接重用。
app.post("/derived-image", async (req) => {
  const b = Job.extend({
    projectId: z.string().uuid(),
    branch: z.string().min(1).max(255),
    items: z
      .array(
        z.object({
          name: z.string().max(100),
          source: z.string().max(500),
          version: z.string().max(100),
          purpose: z.string().max(500),
          commands: z
            .array(z.string().max(MAX_INSTALL_COMMAND_LENGTH))
            .max(MAX_INSTALL_COMMANDS),
        }),
      )
      .min(1)
      .max(MAX_INSTALL_ITEMS),
    domains: Domains,
    timeoutMs: z.number().int().min(1000).max(1800000),
  }).parse(req.body);
  const observe = (e: Parameters<ObservationBuffer["add"]>[2]) =>
    observations.add(b.runId, "install", e);
  await syncEgress(b.domains, observe);
  const result = await derivedImage(containers, {
    runId: b.runId,
    base: b.image,
    projectId: b.projectId,
    branch: b.branch,
    items: b.items,
    domains: b.domains,
    timeoutMs: b.timeoutMs,
  });
  observe({
    kind: "message",
    detail: result.reused
      ? `重用專案衍生映像 ${result.image}，沒有重新下載`
      : result.image
        ? `系統套件安裝完成，建立專案衍生映像 ${result.image}`
        : `系統套件安裝失敗（退出碼 ${result.exitCode}）：${result.output.slice(-2000)}`,
  });
  return result;
});
app.post("/phase", async (req) => {
  const b = Job.extend({
    phase: z.enum(["install", "test", "code", "review", "collect"]),
    command: z.string().max(8000).optional(),
    requiresSqlServer: z.boolean().optional(),
    requiresTests: z.boolean().optional(),
    open: z.boolean().optional(),
    // 完全存取：安裝也走完全開放的網路；env 只接受資料庫連線（AGENTFLOW_DB_*）與 SSH 主機（AGENTFLOW_SSH_HOSTS）。
    full: z.boolean().optional(),
    env: z
      .array(z.string().max(120000).regex(FULL_ACCESS_ENV))
      .max(12)
      .optional(),
    job: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(1800000),
    // 收集差異時排除的建置產物；伺服器已套用專案增減，這裡只接受完整規則。
    exclude: z
      .array(
        z.string().refine((e) => !e.startsWith("!") && validCollectExclude(e)),
      )
      .max(MAX_COLLECT_EXCLUDES + 20)
      .optional(),
    // 下載來源白名單；只在這個階段會經過套件出口時同步到 egress。
    egress: Domains.optional(),
  }).parse(req.body);
  const observe = (e: Parameters<ObservationBuffer["add"]>[2]) =>
    observations.add(b.runId, b.phase, e);
  if (b.phase === "install" || (b.phase === "code" && b.job?.packages === true))
    await syncEgress(b.egress, observe);
  const ai = b.phase === "code" || b.phase === "review";
  const command = ai
    ? ["node", "/opt/agentflow/run.mjs"]
    : b.phase === "collect"
      ? ["node", "/opt/agentflow/collect.mjs"]
      : ["sh", "-c", b.command ?? "exit 1"];
  // 把複驗、發出審查授權與 Codex 容器視作一次可取消的審查。
  const reviewDeadline = b.phase === "review" && b.command
    ? containers.begin(b.runId, b.timeoutMs, new AppError(408, "執行超過時間限制"))
    : undefined;
  try {
    let image = b.image;
    let aiJob = b.job;
    if (reviewDeadline && b.command) {
      // 衍生映像繼承 SQL 能力標記；自管 SQL 的測試命令可完全不含資料庫名稱。
      const meta = await reviewDeadline.run(() => containers.docker.getImage(image).inspect());
      image = meta.Id;
      if (b.requiresSqlServer || meta.Config.Labels?.["io.agentflow.sqlserver-helper"] === "1") {
        const replay = await containers.phase(
          b.runId, image, ["node", "/opt/agentflow/review-sql.mjs"], "none",
          JSON.stringify({
            command: b.command,
            changeManifest: b.job?.changeManifest,
            collectExclude: b.job?.collectExclude,
          }),
          reviewDeadline.remaining(), true, true, observe, { reviewCopy: true },
        );
        const summary = safeDetail([maskCredentials(replay.stdout).slice(-4000), maskCredentials(replay.stderr).slice(-1500)].join("\n").trim());
        const category = replay.exitCode === ENVIRONMENT_EXIT ? "測試環境問題，" : "";
        const detail = `SQL Server 審查複驗（${category}退出碼 ${replay.exitCode}）\n${summary}`;
        observe({ kind: "command_end", exitCode: replay.exitCode, detail });
        if (replay.exitCode !== 0) {
          return { ...replay, sqlReviewFailure: true, stderr: detail, observations: observations.read(b.runId) };
        }
        if (b.requiresSqlServer && testEnvironment(replay.stdout)?.ok !== true)
          throw new AppError(422, "測試環境問題：SQL Server 審查複驗缺少資料庫啟動成功的紀錄");
        if (b.requiresTests) assertTestsFound({ verification: "tests" }, replay.stdout + replay.stderr);
        aiJob = { ...b.job, sqlReviewReport: detail };
      }
    }
    const result = await withCapability(
      b.runId,
      b.phase,
      aiJob,
      reviewDeadline?.remaining() ?? b.timeoutMs,
      (job, remaining) =>
        containers.phase(
          b.runId,
          image,
          command,
          ai
            ? aiNetwork(b.job)
            : b.phase === "install"
              ? b.full === true
                ? "line-agentflow_open"
                : "line-agentflow_install"
              : b.phase === "test" && b.open === true
                ? "line-agentflow_open"
                : "none",
          ai ? JSON.stringify(job) : undefined,
          Math.min(remaining, reviewDeadline?.remaining() ?? remaining),
          b.phase === "review",
          true,
          observe,
          {
            ...(b.phase === "collect" ||
            (b.phase === "code" && b.job?.query === true)
              ? { output: "collect" as const }
              : {}),
            ...(b.phase === "install" ? { nugetFeed: true } : {}),
            onRejectedWorkerEvent: (kind, reason) =>
              observations.rejectWorkerEvent(b.runId, b.phase, kind, reason),
            ...(b.env?.length && b.phase !== "collect" ? { env: b.env } : {}),
            ...(b.phase === "collect" && b.exclude
              ? { collectExclude: b.exclude }
              : {}),
            ...(ai && b.open === true
              ? { extraNetworks: ["line-agentflow_open"] }
              : b.phase === "code" && b.job?.packages === true
                ? { extraNetworks: ["line-agentflow_install"] }
                : {}),
          },
        ),
    );
    for (const event of phaseEndEvents(b.phase, result)) observe(event);
    return { ...result, observations: observations.read(b.runId) };
  } catch (e) {
    observe({
      kind: "error",
      detail: e instanceof Error ? e.message : "執行器階段失敗",
    });
    throw e;
  } finally {
    reviewDeadline?.close();
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
      sensitive: z.boolean().optional(),
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
          undefined,
          { sensitive: b.sensitive },
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
// 檢查環境的機密只在上一個執行器程序的記憶體裡，重啟後全部重建。
await checkEnvironments.cleanupAll();
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
