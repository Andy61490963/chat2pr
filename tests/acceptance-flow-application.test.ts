import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { archiveRunner, flowEnvironment, flowGitHubOAuth, pollFlowStep } from "../scripts/acceptance/flows/application.js";
import { createAcceptanceFetch } from "../scripts/acceptance/flows/chat-provider.js";
import { createGitHubProvider } from "../scripts/acceptance/flows/github-provider.js";
import { GitHub } from "../server/github.js";
import type { Project } from "../shared/types.js";

// 只供下方 HTTP 傳輸測試使用。測試程序不需要機密檔或資料庫。
const fixture = vi.hoisted(() => ({ runnerUrl: "", githubPrivateKey: "" }));
vi.mock("../server/config.js", async original => ({
  ...await original<typeof import("../server/config.js")>(),
  config: () => ({ runnerUrl: fixture.runnerUrl }),
  secrets: () => ({ githubAppId: "26601", githubPrivateKey: fixture.githubPrivateKey }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fixture.runnerUrl = "";
  fixture.githubPrivateKey = "";
});

const dir = resolve("verify-flow-unit");
const env = {
  AGENTFLOW_INSTANCE: "verify-flow-unit", SECRETS_FILE: join(dir, "secrets.json"), DATA_DIR: join(dir, "data"),
  HOST: "127.0.0.1", PORT: "14310", PUBLIC_URL: "http://127.0.0.1:14310",
  RUNNER_LISTEN_PORT: "14312", RUNNER_URL: "http://127.0.0.1:14312",
  DATABASE_URL: "postgres://127.0.0.1:15439/lantern_test", ADMIN_GITHUB_ID: "266001",
  ACCEPTANCE_MODEL_ORIGIN: "http://127.0.0.1:18080",
};

it("啟動前核對本機入口、獨立資料庫與已載入的設定檔路徑", () => {
  expect(flowEnvironment(env, env.SECRETS_FILE)).toMatchObject({
    databaseUrl: env.DATABASE_URL, adminId: env.ADMIN_GITHUB_ID, origin: env.PUBLIC_URL,
  });
  for (const overrides of [
    { NODE_ENV: "production" }, { AGENTFLOW_INSTANCE: "production" },
    { DATABASE_URL: "postgres://127.0.0.1:15439/lantern" },
    { DATABASE_URL: env.DATABASE_URL + "?host=outside.invalid" },
    { DATABASE_URL: "postgres://outside.invalid:15439/lantern_test" },
    { PUBLIC_URL: "http://127.0.0.1:4310", PORT: "4310" },
    { RUNNER_URL: env.PUBLIC_URL, RUNNER_LISTEN_PORT: env.PORT },
    { DATA_DIR: resolve("data") }, { ADMIN_GITHUB_ID: "lantern" },
  ]) expect(() => flowEnvironment({ ...env, ...overrides }, env.SECRETS_FILE)).toThrow();
  expect(() => flowEnvironment(env, resolve("other", "secrets.json"))).toThrow("首次匯入");
});

it("劇本模式要求本機模型，只有明確選用真實訂閱才能省略", () => {
  const noModel = { ...env, ACCEPTANCE_MODEL_ORIGIN: undefined };
  expect(() => flowEnvironment(noModel, env.SECRETS_FILE)).toThrow();
  expect(flowEnvironment({ ...noModel, ACCEPTANCE_FLOW_REAL: "1" }, env.SECRETS_FILE).instance)
    .toBe(env.AGENTFLOW_INSTANCE);
  expect(() => flowEnvironment({ ...env, ACCEPTANCE_FLOW_REAL: "1" }, env.SECRETS_FILE)).toThrow();
  expect(() => flowEnvironment({ ...env, ACCEPTANCE_MODEL_ORIGIN: "https://example.invalid" }, env.SECRETS_FILE)).toThrow();
});

it("查驗失敗立即傳回原因，沒有回應的步驟最多等待三分鐘", async () => {
  const error = new Error("驗證失敗：測試命令結束碼為 1");
  await expect(pollFlowStep("驗證基底", async () => { throw error; })).rejects.toBe(error);
  vi.useFakeTimers();
  try {
    const waiting = pollFlowStep("群組收到回覆", () => new Promise<never>(() => {}));
    const check = expect(waiting).rejects.toThrow("等待逾時：群組收到回覆");
    await vi.advanceTimersByTimeAsync(180_000);
    await check;
  } finally {
    vi.useRealTimers();
  }
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done, fail) => {
    server.close(error => error ? fail(error) : done());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("無法取得測試埠");
  return "http://127.0.0.1:" + address.port;
}

it("OAuth code 綁定指定的 client 及回呼，兌換一次後才能以 bearer 讀取擁有者", async () => {
  vi.stubEnv("AGENTFLOW_INSTANCE", env.AGENTFLOW_INSTANCE);
  const client = { id: "lantern-client", secret: "lantern-fixture", callback: env.PUBLIC_URL + "/auth/github/callback", owner: env.ADMIN_GITHUB_ID };
  const oauth = flowGitHubOAuth(client, (_req, res) => res.writeHead(404).end());
  const githubOrigin = await listen(oauth.handler);
  const request = createAcceptanceFetch({ githubOrigin });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: client.id, state: "lantern-state", redirect_uri: client.callback }).toString();
  const callback = new URL(oauth.authorize(url.href), env.PUBLIC_URL);
  expect(callback.pathname).toBe("/auth/github/callback");
  expect(callback.searchParams.get("state")).toBe("lantern-state");
  url.searchParams.set("redirect_uri", "https://example.invalid");
  expect(() => oauth.authorize(url.href)).toThrow();
  const grant = { client_id: client.id, client_secret: client.secret, redirect_uri: client.callback, code: callback.searchParams.get("code") };
  const exchange = (body: typeof grant) => request("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const user = (token: string) => request("https://api.github.com/user", { headers: { authorization: "Bearer " + token } });
  expect((await user("unknown")).status).toBe(401);
  expect((await exchange({ ...grant, client_secret: "incorrect" })).status).toBe(401);
  expect((await exchange({ ...grant, redirect_uri: "https://example.invalid" })).status).toBe(401);
  const response = await exchange(grant);
  expect(response.status).toBe(200);
  const token = z.object({ access_token: z.string().min(1) }).parse(await response.json());
  expect(await (await user(token.access_token)).json()).toEqual({ id: 266001, login: "lantern-owner" });
  expect((await exchange(grant)).status).toBe(401);
});

it("正式 Octokit 以合成 RSA 取得安裝授權，HttpRunner 把指定版本的封存上傳到本機 /prepare", async () => {
  vi.stubEnv("AGENTFLOW_INSTANCE", env.AGENTFLOW_INSTANCE);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fixture.githubPrivateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const github = await createGitHubProvider();
  let signed = false;
  const githubOrigin = await listen((req, res) => {
    if (req.url === "/app/installations/" + github.fixture.installationId + "/access_tokens") {
      const [header, payload, signature] = (req.headers.authorization ?? "").replace(/^bearer /i, "").split(".");
      if (header && payload && signature)
        signed = verify("RSA-SHA256", Buffer.from(header + "." + payload), keys.publicKey, Buffer.from(signature, "base64url"));
      if (!signed) { res.writeHead(401).end(); return; }
    }
    return github.handler(req, res);
  });
  vi.stubGlobal("fetch", createAcceptanceFetch({ githubOrigin }));
  const uploads: { path: string; type?: string; authorized: boolean; bytes: Buffer }[] = [];
  fixture.runnerUrl = await listen(async (req, res) => {
    uploads.push({ path: req.url ?? "", type: req.headers["content-type"],
      authorized: req.headers["x-runner-key"] === "lantern-runner", bytes: await buffer(req) });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const { HttpRunner } = await import("../server/execution.js");
  const runner = archiveRunner(new HttpRunner(() => "lantern-runner"));
  const project: Project = {
    id: "26600000-0000-4000-8000-000000000001", name: "燈會票務", repo: github.fixture.repo,
    base_branch: "main", config_version: 1, description: "", image: "lantern-worker", sensitive_paths: [],
    install_command: "", test_command: "npm test", enabled: false, validated_at: null,
    validation_error: null, created_at: "2026-01-01",
  };
  const client = new GitHub();
  const sha = await client.base(project);
  expect(sha).toBe(github.fixture.baseSha);
  expect(runner.prepareSource).toBeUndefined();
  await runner.upload("lantern-run", project.image, await client.archive(project, sha));
  expect(signed).toBe(true);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({
    path: "/prepare?runId=lantern-run&image=lantern-worker", type: "application/octet-stream", authorized: true,
  });
  const expected = await fetch(githubOrigin + "/repos/" + project.repo + "/tarball/" + sha);
  expect(expected.status).toBe(200);
  expect(uploads[0].bytes).toEqual(Buffer.from(await expected.arrayBuffer()));
  expect(gunzipSync(uploads[0].bytes).includes(Buffer.from("tickets.test.mjs"))).toBe(true);
});
