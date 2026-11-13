import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
export interface Secrets {
  openaiKey?: string;
  lineSecret?: string;
  lineToken?: string;
  githubAppId?: string;
  githubPrivateKey?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubWebhookSecret?: string;
  githubInstallationId?: string;
  sessionSecret?: string;
  runnerSecret?: string;
  ngrokToken?: string;
  publicUrl?: string;
  /** 固定 HTTPS 入口由誰維護；未設定時依已填的憑證判斷。 */
  tunnelProvider?: "ngrok" | "cloudflare" | "external";
  /** Cloudflare 後台管理的通道權杖。 */
  cloudflareTunnelToken?: string;
  /** 本機管理的 Cloudflare 通道設定檔路徑（config.yml）。 */
  cloudflareConfig?: string;
}
export const secretsPath = resolve(
  process.env.SECRETS_FILE ?? ".local/secrets.json",
);
export function secrets(): Secrets {
  try {
    return JSON.parse(readFileSync(secretsPath, "utf8"));
  } catch {
    return {};
  }
}
/** 正式環境保留既有名稱；驗收環境必須明確具名，不能落入正式資源。 */
export function instanceName(
  value = process.env.AGENTFLOW_INSTANCE ?? "production",
) {
  if (!/^(production|verify-[a-z0-9][a-z0-9-]{0,47})$/.test(value))
    throw new Error(
      "AGENTFLOW_INSTANCE 必須是 production 或 verify-<suiteId>（小寫英數與連字號）",
    );
  return value;
}
export function validateRunnerEnvironment(env = process.env) {
  const instance = instanceName(env.AGENTFLOW_INSTANCE);
  if (instance === "production") {
    subscriptionBrokerPort(env);
    return;
  }
  for (const key of ["SECRETS_FILE", "CODEX_SERVICE_HOME"] as const) {
    const path = env[key];
    if (!path || !resolve(path).split(/[\\/]/).includes(instance))
      throw new Error(
        `驗收執行器的 ${key} 必須明確指定於 ${instance} 專用目錄`,
      );
  }
  const port = Number(env.RUNNER_LISTEN_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4312)
    throw new Error("驗收執行器必須明確指定非正式的 RUNNER_LISTEN_PORT");
  subscriptionBrokerPort(env);
  let local: Secrets = {};
  try {
    local = JSON.parse(readFileSync(resolve(env.SECRETS_FILE!), "utf8"));
  } catch {
    throw new Error("驗收執行器需要已建立的專用機密設定檔");
  }
  if (!local.runnerSecret || local.runnerSecret.length < 32)
    throw new Error("驗收執行器需要至少 32 字元的獨立 runnerSecret");
}
export function subscriptionBrokerPort(env = process.env) {
  const runnerPort = Number(env.RUNNER_LISTEN_PORT ?? 4312);
  const port = Number(env.SUBSCRIPTION_BROKER_PORT ?? runnerPort + 1);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === runnerPort ||
    (instanceName(env.AGENTFLOW_INSTANCE) !== "production" &&
      [4312, 4313].includes(port))
  )
    throw new Error("訂閱代理必須使用此執行環境的獨立連接埠");
  return port;
}
export function config() {
  const s = secrets();
  return {
    instance: instanceName(),
    port: Number(process.env.PORT ?? 4310),
    host: process.env.HOST ?? "127.0.0.1",
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://localhost/agentflow_requires_DATABASE_URL",
    publicUrl: s.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:4310",
    // 擁有者沒有內建預設值；由每台伺服器的 .env 指定，缺少時 app 拒絕啟動。
    adminId: process.env.ADMIN_GITHUB_ID?.trim() ?? "",
    runnerUrl: process.env.RUNNER_URL ?? "http://127.0.0.1:4312",
    dataDir: resolve(process.env.DATA_DIR ?? ".local/data"),
  };
}
export function token() {
  return randomBytes(32).toString("hex");
}
