import { randomBytes } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { dirname, resolve } from "node:path";
import { MEMORY_STEADY_MS } from "../../../server/capacity.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../../server/db.js";
import type { DiscordGateway, DiscordMessageEvent } from "../../../server/discord.js";
import type { HttpRunner, Runner } from "../../../server/execution.js";
import { discordId } from "../../../server/chat-platform.js";
import { acceptanceRunnerReady } from "../setup-config.js";
import { basicFixture, type BasicFlowContext } from "./basic.js";
import type { startChatProvider } from "./chat-provider.js";
import type { createGitHubProvider } from "./github-provider.js";
import type { OperationsControls } from "./operations.js";
import { operationsInstance, operationsPhaseInput, type WorkerFault } from "./operations-worker.js";

type Chat = Awaited<ReturnType<typeof startChatProvider>>;
type GitHubProvider = Awaited<ReturnType<typeof createGitHubProvider>>;

export interface FlowApplicationOptions {
  github: GitHubProvider;
  chat: Chat;
  workerImage: string;
  autoSetup?: boolean;
  setModelSteps?: OperationsControls["setModelSteps"];
  restartRunner?: OperationsControls["restartRunner"];
}

const required = z.string().min(1);
const flowSecrets = z.object({
  runnerSecret: z.string().min(32),
  githubAppId: z.string().regex(/^[1-9]\d*$/),
  githubPrivateKey: required,
  githubWebhookSecret: required,
  githubClientId: required,
  githubClientSecret: required,
  lineSecret: required,
  lineToken: required,
  discordToken: required,
  discordApplicationId: z.literal(basicFixture.discord.applicationId),
});

const reservedPorts = new Set(["4310", "4311", "4312", "4313", "4314", "5439"]);
function localEndpoint(value: string | undefined, database = false) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("缺少有效的驗收服務位址");
  }
  const valid = database
    ? ["postgres:", "postgresql:"].includes(url.protocol) && /^\/[a-z][a-z0-9_]*_test$/.test(url.pathname)
    : url.protocol === "http:" && url.pathname === "/" && !url.username && !url.password;
  if (!valid || url.hostname !== "127.0.0.1" || Number(url.port) < 1024 ||
      reservedPorts.has(url.port) || url.search || url.hash)
    throw new Error("驗收服務必須使用本機專用埠，資料庫名稱必須以 _test 結尾");
  return url;
}

/** 先檢查純環境值，才允許正式 config 讀取本次 stack 建立的設定。 */
export function flowEnvironment(env: NodeJS.ProcessEnv, loadedSecretsPath: string) {
  const instance = env.AGENTFLOW_INSTANCE;
  if (!instance || !/^verify-[a-z0-9][a-z0-9-]{0,47}$/.test(instance) || env.NODE_ENV === "production")
    throw new Error("流程只能使用具名的隔離驗收實例");
  if (!env.SECRETS_FILE || resolve(env.SECRETS_FILE) !== loadedSecretsPath ||
      !dirname(loadedSecretsPath).split(/[\\/]/).includes(instance) ||
      !env.DATA_DIR || !resolve(env.DATA_DIR).split(/[\\/]/).includes(instance))
    throw new Error("請在首次匯入 config 前指定本次實例的 SECRETS_FILE 及 DATA_DIR");
  const publicUrl = localEndpoint(env.PUBLIC_URL), runner = localEndpoint(env.RUNNER_URL);
  const db = localEndpoint(env.DATABASE_URL, true);
  const real = env.ACCEPTANCE_FLOW_REAL === "1";
  if (real && env.ACCEPTANCE_MODEL_ORIGIN !== undefined)
    throw new Error("真實訂閱模式不能另指定劇本上游");
  const ports = [publicUrl.port, runner.port, db.port];
  if (!real) ports.push(localEndpoint(env.ACCEPTANCE_MODEL_ORIGIN).port);
  if (env.HOST !== "127.0.0.1" || env.PORT !== publicUrl.port || env.RUNNER_LISTEN_PORT !== runner.port ||
      new Set(ports).size !== ports.length)
    throw new Error("app、runner、資料庫及劇本上游必須使用本次 stack 的不同埠");
  const adminId = env.ADMIN_GITHUB_ID?.trim();
  if (!adminId || !/^[1-9]\d*$/.test(adminId) || !Number.isSafeInteger(Number(adminId)))
    throw new Error("請指定虛構擁有者的 GitHub 數字 ID");
  return { instance, origin: publicUrl.origin, adminId, databaseUrl: db.href, runnerUrl: runner.origin };
}

type OAuthClient = { id: string; secret: string; callback: string; owner: string };
const opaque = () => randomBytes(32).toString("hex");

/** 只有本次瀏覽器授權簽發的 code 能換取 /user 接受的 bearer。 */
export function flowGitHubOAuth(client: OAuthClient, repository: RequestListener) {
  let code: string | undefined, bearer: string | undefined;
  const grant = z.object({
    code: required,
    redirect_uri: z.literal(client.callback),
    client_id: z.literal(client.id),
    client_secret: z.literal(client.secret),
  });
  const handler: RequestListener = async (req, res) => {
    const json = (status: number, data: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/user") {
      if (req.method === "GET" && bearer && req.headers.authorization === "Bearer " + bearer)
        json(200, { id: Number(client.owner), login: "lantern-owner" });
      else json(401, {});
      return;
    }
    if (req.url !== "/login/oauth/access_token") return repository(req, res);
    if (req.method !== "POST") { json(405, {}); return; }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) { json(413, {}); return; }
        chunks.push(chunk);
      }
      const body = grant.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!code || !body.success || body.data.code !== code) {
        json(401, {});
        return;
      }
      code = undefined;
      bearer = opaque();
      json(200, { access_token: bearer, token_type: "bearer" });
    } catch {
      json(400, {});
    }
  };
  return {
    handler,
    authorize(location: string) {
      const url = new URL(location);
      const params = url.searchParams;
      const state = params.get("state");
      if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize" ||
          url.username || url.password || params.get("client_id") !== client.id ||
          params.get("redirect_uri") !== client.callback || !state)
        throw new Error("登入入口未回傳預期的 OAuth 授權請求");
      const callback = new URL(client.callback);
      code = opaque();
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return callback.pathname + callback.search;
    },
  };
}

async function login(app: FastifyInstance, origin: string, owner: string, authorize: (url: string) => string) {
  const host = new URL(origin).host;
  const start = await app.inject({ url: "/auth/github", headers: { host } });
  const state = start.cookies.find(c => c.name === "af_oauth");
  if (start.statusCode !== 302 || !state || !start.headers.location)
    throw new Error("登入入口未建立 OAuth state");
  const callback = await app.inject({
    url: authorize(String(start.headers.location)), headers: { host }, cookies: { af_oauth: state.value },
  });
  const session = callback.cookies.find(c => c.name === "af_session");
  if (callback.statusCode !== 302 || callback.headers.location !== "/" || !session)
    throw new Error(`GitHub 登入回呼失敗（HTTP ${callback.statusCode}）`);
  const cookies = { af_session: session.value };
  const me = await app.inject({ url: "/api/me", headers: { host }, cookies });
  const profile = me.statusCode === 200 && z.object({
    id: z.literal(owner), login: z.literal("lantern-owner"), owner: z.literal(true),
    role: z.literal("admin"), csrf: required,
  }).safeParse(me.json());
  if (!profile || !profile.success) throw new Error("無法從 /api/me 確認虛構擁有者身分");
  const headers = { host, origin, "x-csrf-token": profile.data.csrf };
  return async (method: "GET" | "POST" | "PUT", path: string, payload?: Record<string, unknown>) => {
    const result = await app.inject({ method, url: path, payload, headers, cookies });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      const failure = result.headers["content-type"]?.toString().includes("application/json")
        && z.object({ error: z.string() }).safeParse(result.json());
      const reason = failure && failure.success ? "：" + failure.data.error : "";
      throw new Error(`${method} ${path} 失敗（HTTP ${result.statusCode}）${reason}`);
    }
    return result.json<unknown>();
  };
}

/** 使用 Execution 支援的封存入口，保留 HttpRunner 的傳輸、額度與執行觀測。 */
export function archiveRunner(http: HttpRunner): Runner {
  return {
    call: http.call.bind(http),
    account: http.account.bind(http),
    upload: http.upload.bind(http),
    uploadEnvironment: http.uploadEnvironment.bind(http),
    observations: http.observations.bind(http),
    applyCandidate: http.applyCandidate.bind(http),
  };
}

/** 只縮小本輪的資源讀數，其他 runner 呼叫及實際安全限制都沿用原本的傳輸。 */
export function operationsRunner(base: Runner) {
  let ceiling: number | null = null, fault: WorkerFault = null;
  const runner: Runner = {
    ...base,
    async call<T>(path: string, body: unknown, timeoutMs?: number) {
      const result = await base.call<T>(path, operationsPhaseInput(fault, path, body), timeoutMs);
      if (path !== "resources" || ceiling === null) return result;
      operationsInstance();
      const { memFreeMb } = z.object({ memFreeMb: z.number().nonnegative() }).parse(result);
      return Object.assign({}, result, { memFreeMb: Math.min(ceiling, memFreeMb) });
    },
  };
  return { runner,
    async setMemoryCeiling(mb: number | null) {
      operationsInstance();
      ceiling = z.int().nonnegative().nullable().parse(mb);
    },
    async setWorkerFault(value: WorkerFault) {
      operationsInstance();
      fault = z.enum(["install", "create"]).nullable().parse(value);
    },
  };
}

function fixtureGateway(chat: Chat) {
  let callbacks: Parameters<DiscordGateway["start"]>[1] | undefined;
  const adapter: DiscordGateway = {
    start(_token, receiver) { callbacks = receiver; },
    async stop() { callbacks = undefined; },
  };
  const dispatch: BasicFlowContext["gateway"] = async packet => {
    const { d } = packet;
    const fixture = basicFixture.discord;
    const input = d.data.options.find(option => option.name === "需求" && option.type === 3);
    if (packet.op !== 0 || packet.t !== "INTERACTION_CREATE" || d.type !== 2 || d.data.type !== 1 ||
        d.data.name !== "任務" || !input || !callbacks?.interaction ||
        d.guild_id !== fixture.guildId || d.channel_id !== fixture.channelId ||
        d.channel.id !== d.channel_id || d.application_id !== fixture.applicationId)
      throw new Error("無法將這個 Gateway 封包投遞至驗收頻道");
    chat.registerDiscordInteraction({
      id: d.id, applicationId: d.application_id, token: d.token, channelId: d.channel_id,
    });
    await callbacks.interaction({
      kind: "task", id: d.id, applicationId: d.application_id, token: d.token,
      channel: d.channel_id, name: "燈會／#票務", botId: fixture.applicationId,
      member: { id: d.member.user.id, name: d.member.user.username }, text: input.value,
    });
  };
  return {
    adapter, dispatch,
    async event(event: DiscordMessageEvent) {
      operationsInstance();
      if (!callbacks) throw new Error("Discord 接收器尚未啟動");
      const d = basicFixture.discord;
      const group = event.type === "create" ? (event.parentChannel ?? event.channel) : event.channel;
      if (group !== d.channelId || ("botId" in event && event.botId !== d.applicationId) ||
          (event.type === "create" && event.author.id !== d.userId))
        throw new Error("Discord 事件不屬於驗收頻道");
      await callbacks.event(event);
    },
    async ready() {
      if (!callbacks) throw new Error("Discord 接收器尚未啟動");
      await callbacks.health("connected");
    },
  };
}

export async function pollFlowStep<T>(label: string, probe: () => Promise<T | undefined>, memoryHold?: () => Promise<boolean>): Promise<T> {
  const limit = 3 * 60_000;
  let deadline = Date.now() + limit;
  const expired = new Error(`等待逾時：${label}`);
  async function before<R>(result: Promise<R>, remaining: number) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired), remaining); });
    try { return await Promise.race([result, timeout]); } finally { clearTimeout(timer); }
  }
  for (;;) {
    if (Date.now() >= deadline) {
      if (!memoryHold || !await before(memoryHold(), 5000)) throw expired;
      memoryHold = undefined;
      deadline = Date.now() + MEMORY_STEADY_MS + limit;
    }
    const result = await before(probe(), deadline - Date.now());
    if (result !== undefined) return result;
    await new Promise<void>(done => setTimeout(done, Math.max(0, Math.min(1000, deadline - Date.now()))));
  }
}

export async function prepareProject(db: Pick<Database, "settings" | "one" | "query">,
  admin: Awaited<ReturnType<typeof login>>, repo: string, image: string, autoSetup: boolean) {
  await admin("POST", "/api/integrations/check");
  await admin("PUT", "/api/settings", {
    ...await db.settings(), paused: false, code_downloads: false, auto_memory: false,
    container_network: "isolated", ai_mode: "subscription", coding_effort: "high",
  });
  const { id } = z.object({ id: z.uuid() }).parse(await admin("POST", "/api/projects", {
    name: basicFixture.project, repo, base_branch: basicFixture.branch, image,
    enabled: false, setup_mode: autoSetup ? "auto" : "manual", sql_server: "never", sensitive_paths: [],
    install_command: "npm ci --offline --ignore-scripts --no-audit --no-fund", test_command: "npm test",
  }));
  await admin("POST", `/api/projects/${id}/validate`);
  await pollFlowStep("燈會專案通過環境驗證", async () => {
    const row = await db.one<{ enabled: boolean; validated_at: Date | null; validation_error: string | null }>(
      "SELECT enabled,validated_at,validation_error FROM projects WHERE id=$1", [id],
    );
    if (row.validation_error) throw new Error("燈會專案環境驗證失敗：" + row.validation_error);
    return row.enabled && row.validated_at ? true : undefined;
  });
  // 新資料庫沒有已加入的群組。只建立停用的清單項目，綁定與啟用仍經管理 API。
  for (const [group, platform, name, trigger_mode] of [
    [basicFixture.line.groupId, "line", "燈會志工", "auto"],
    [discordId(basicFixture.discord.channelId), "discord", "燈會／#票務", "command"],
  ]) {
    await db.query("INSERT INTO groups(id,name,platform,enabled) VALUES($1,$2,$3,false)", [group, name, platform]);
    await admin("PUT", "/api/groups/" + encodeURIComponent(group), {
      name, enabled: true, project_ids: [id], trigger_mode, reply_mode: "all",
    });
  }
  return id;
}

let active = false;

/** 主控先套用 stack.env，再提供同一輪的 GitHub 及聊天替身。close 後由主控清理 stack。 */
export async function startFlowApplication({ github, chat, workerImage, autoSetup = false, restartRunner, setModelSteps }: FlowApplicationOptions) {
  if (active) throw new Error("同一程序已有使用驗收路由的 app");
  active = true;
  const resources = new AsyncDisposableStack();
  resources.defer(() => { active = false; });
  try {
    const { secretsPath, secrets, config } = await import("../../../server/config.js");
    const env = flowEnvironment(process.env, secretsPath);
    const keys = flowSecrets.safeParse(secrets());
    if (!keys.success) throw new Error("驗收設定缺少合成金鑰或 Discord 應用程式 ID 不符");
    const s = keys.data;
    if (config().publicUrl !== env.origin || !workerImage.trim())
      throw new Error("驗收公開入口或工作映像設定錯誤");
    const oauth = flowGitHubOAuth({
      id: s.githubClientId, secret: s.githubClientSecret,
      callback: env.origin + "/auth/github/callback", owner: env.adminId,
    }, github.handler);
    const server = createServer(oauth.handler);
    await new Promise<void>((done, fail) => {
      server.once("error", fail).listen(0, "127.0.0.1", done);
    });
    resources.defer(() => new Promise<void>((done, fail) => {
      server.close(error => error ? fail(error) : done());
      server.closeAllConnections();
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("無法取得 GitHub 驗收服務的埠");
    const { createAcceptanceFetch } = await import("./chat-provider.js");
    const previous = globalThis.fetch;
    globalThis.fetch = createAcceptanceFetch({ chatOrigin: chat.origin, githubOrigin: "http://127.0.0.1:" + address.port });
    resources.defer(() => { globalThis.fetch = previous; });
    if (!await acceptanceRunnerReady(env.runnerUrl, s.runnerSecret, env.instance))
      throw new Error("本次驗收的 runner 尚未啟動");
    const { Database } = await import("../../../server/db.js");
    const db = new Database(env.databaseUrl);
    resources.defer(() => db.close());
    const fresh = await db.one<{ empty: boolean }>(
      "SELECT to_regclass('public.settings') IS NULL AND to_regnamespace('pgboss') IS NULL AS empty",
    );
    if (!fresh.empty) throw new Error("驗收需要全新資料庫，此資料庫已有 app 或工作佇列");
    await db.migrate();
    const { startDiscord } = await import("../../../server/discord.js");
    const { REST } = await import("discord.js");
    if (chat.discord.rest instanceof REST) chat.discord.rest.setToken(s.discordToken);
    const gateway = fixtureGateway(chat);
    const discord = startDiscord(db, s.discordToken, () => gateway.adapter, chat.discord, s.discordApplicationId);
    resources.defer(() => discord.stop());
    await gateway.ready();
    const { HttpRunner } = await import("../../../server/execution.js");
    const { runner, setMemoryCeiling, setWorkerFault } = operationsRunner(archiveRunner(new HttpRunner()));
    const { startJobs } = await import("../../../server/jobs.js");
    const jobs = await startJobs(db, { discord: chat.discord, runner });
    resources.defer(() => jobs.stop());
    const { buildApp } = await import("../../../server/app.js");
    const app = await buildApp(db, jobs.enqueueValidation, undefined, undefined, runner, jobs.validationProgress);
    resources.defer(() => app.close());
    await app.listen({ host: "127.0.0.1", port: Number(new URL(env.origin).port) });
    const admin = await login(app, env.origin, env.adminId, oauth.authorize);
    const repository = github.fixture.repo;
    const projectId = await prepareProject(db, admin, repository, workerImage, autoSetup);
    const ctx: BasicFlowContext = {
      db, projectId, repository, admin,
      poll: (label, probe) => pollFlowStep(label, probe, async () => {
        const capacity = z.object({ holdKind: z.string().nullable() }).parse(await admin("GET", "/api/capacity"));
        return capacity.holdKind === "memory";
      }),
      lineSecret: s.lineSecret, githubWebhookSecret: s.githubWebhookSecret,
      groupMessages: chat.groupMessages, readPr: github.readPr, gateway: gateway.dispatch,
      async webhook(request) {
        if (request.url === "/webhooks/line") {
          const body = z.object({ events: z.array(z.object({
            replyToken: required.optional(), source: z.object({ groupId: required }),
          })) }).parse(JSON.parse(request.payload));
          for (const event of body.events) if (event.replyToken) chat.registerLineReply(event.replyToken, event.source.groupId);
        }
        const { statusCode } = await app.inject(request);
        if (statusCode === 200 && request.url === "/webhooks/github" && request.headers["x-github-event"] === "pull_request") {
          // 定時 PR 同步也會查詢替身，須與已投遞的合併事件一致。
          const merged = z.object({
            action: z.literal("closed"), repository: z.object({ full_name: z.literal(repository) }),
            pull_request: z.object({ merged: z.literal(true), number: z.number().int().positive() }),
          }).safeParse(JSON.parse(request.payload));
          if (merged.success) {
            const pr = github.state.pulls.get(merged.data.pull_request.number);
            if (!pr) throw new Error("合併事件在驗收儲存庫找不到對應 PR");
            pr.state = "closed";
            pr.merged = true;
          }
        }
        return { statusCode };
      },
    };
    const operations: OperationsControls = {
      setMemoryCeiling, setWorkerFault, discordEvent: gateway.event,
      setLineQuotaExhausted: chat.setLineQuotaExhausted,
      putSettings: body => admin("PUT", "/api/settings", body),
      async restartRunner(runId) {
        operationsInstance();
        if (!restartRunner) throw new Error("主控尚未接上 runner 重啟 IPC");
        return restartRunner(z.uuid().parse(runId));
      },
      async setModelSteps(steps) {
        operationsInstance();
        if (!setModelSteps) throw new Error("主控尚未接上模型劇本 IPC");
        await setModelSteps(steps);
      },
    };
    return { ctx, db, operations, close: () => resources.disposeAsync() };
  } catch (error) {
    try { await resources.disposeAsync(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "驗收 app 啟動失敗且清理未完成"); }
    throw error;
  }
}
