import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Containers } from "../../server/containers.js";
import {
  acceptanceSetupConfig,
  pinSubscriptionRelay,
  acceptanceRunnerReady,
} from "./setup-config.js";
import {
  instanceName,
  validateRunnerEnvironment,
} from "../../server/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const instance = instanceName(process.env.AGENTFLOW_INSTANCE);
if (instance === "production") throw new Error("驗收啟動器禁止使用 production");
const sourceAuth = process.env.ACCEPTANCE_AUTH_SOURCE;
if (!sourceAuth || !existsSync(sourceAuth))
  throw new Error("請明確指定 ACCEPTANCE_AUTH_SOURCE 的受保護登入檔");
if (!process.env.ACCEPTANCE_MODEL_VOLUME)
  throw new Error("請指定唯讀的 ACCEPTANCE_MODEL_VOLUME");
const dbName = process.env.ACCEPTANCE_DB_NAME;
if (!dbName || !/^[a-z][a-z0-9_]*_test$/.test(dbName))
  throw new Error("資料庫必須是獨立的 *_test 名稱");
const { ports, relayImage } = acceptanceSetupConfig(process.env);
const relayImageId = pinSubscriptionRelay(
  JSON.parse(
    execFileSync("docker", ["image", "inspect", relayImage], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    }),
  ),
);
const dir = resolve(root, ".local/acceptance", instance);
mkdirSync(dir, { recursive: true });
if (process.platform === "win32") {
  const user = execFileSync("whoami", [], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  execFileSync(
    "icacls",
    [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
    { stdio: "ignore", windowsHide: true },
  );
}
const secretFile = join(dir, "secrets.json"),
  codexHome = join(dir, "codex");
mkdirSync(codexHome, { recursive: true });
if (!existsSync(secretFile))
  writeFileSync(
    secretFile,
    JSON.stringify({ runnerSecret: randomBytes(32).toString("hex") }),
    { mode: 0o600, flag: "wx" },
  );
if (!existsSync(join(codexHome, "auth.json"))) {
  const raw = readFileSync(sourceAuth, "utf8"),
    parsed = JSON.parse(raw);
  if (!parsed.tokens && !parsed.OPENAI_API_KEY)
    throw new Error("來源檔不是有效的 Codex 登入格式");
  writeFileSync(join(codexHome, "auth.json"), raw, { mode: 0o600, flag: "wx" });
}
const env = {
  ...process.env,
  AGENTFLOW_INSTANCE: instance,
  SECRETS_FILE: secretFile,
  CODEX_SERVICE_HOME: codexHome,
  RUNNER_LISTEN_PORT: String(ports.runner),
  SUBSCRIPTION_BROKER_PORT: String(ports.broker),
  SUBSCRIPTION_RELAY_URL: "http://subscription-relay:4313",
  ACCEPTANCE_SUBSCRIPTION_BROKER_PORT: String(ports.broker),
  ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE: relayImageId,
  RUNNER_URL: `http://127.0.0.1:${ports.runner}`,
  PORT: String(ports.app),
  HOST: "127.0.0.1",
  PUBLIC_URL: `http://127.0.0.1:${ports.app}`,
  DATA_DIR: join(dir, "data"),
  DATABASE_URL: `postgres://agentflowtest:test-only-password@127.0.0.1:${ports.db}/${dbName}`,
  EMBEDDER_URL: `http://127.0.0.1:${ports.model}`,
  ACCEPTANCE_DB_PORT: String(ports.db),
  ACCEPTANCE_MODEL_PORT: String(ports.model),
  SOURCE_CACHE_IMAGE:
    process.env.SOURCE_CACHE_IMAGE ?? "line-agentflow-source:acceptance",
};
validateRunnerEnvironment(env);
// 只保留明列的非機密環境，不將主機 process.env 存入檔案。
const runtime = Object.fromEntries(
  [
    "AGENTFLOW_INSTANCE",
    "SECRETS_FILE",
    "CODEX_SERVICE_HOME",
    "RUNNER_LISTEN_PORT",
    "SUBSCRIPTION_BROKER_PORT",
    "SUBSCRIPTION_RELAY_URL",
    "ACCEPTANCE_SUBSCRIPTION_BROKER_PORT",
    "ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE",
    "RUNNER_URL",
    "PORT",
    "HOST",
    "PUBLIC_URL",
    "DATA_DIR",
    "DATABASE_URL",
    "EMBEDDER_URL",
    "SOURCE_CACHE_IMAGE",
    "ACCEPTANCE_DB_PORT",
    "ACCEPTANCE_MODEL_PORT",
    "ACCEPTANCE_DB_NAME",
    "ACCEPTANCE_MODEL_VOLUME",
  ].map((key) => [key, env[key as keyof typeof env]]),
);
writeFileSync(join(dir, "runtime.json"), JSON.stringify(runtime, null, 2), {
  mode: 0o600,
});
execFileSync(
  "docker",
  [
    "compose",
    "-f",
    "scripts/acceptance/compose.yaml",
    "--profile",
    "model",
    "up",
    "-d",
    "--build",
  ],
  { cwd: root, env, stdio: "inherit", windowsHide: true, timeout: 300000 },
);
const containers = new Containers(instance);
for (const role of ["workers", "source"]) {
  const name = `${instance}_${role}`;
  try {
    await containers.docker.getNetwork(name).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    await containers.docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: role === "workers",
      Labels: containers.labels(),
    });
  }
  await containers.assertNetwork(name);
}
const key = JSON.parse(readFileSync(secretFile, "utf8")).runnerSecret;
async function health() {
  return acceptanceRunnerReady(env.RUNNER_URL, key, instance);
}
if (!(await health())) {
  const log = openSync(join(dir, "runner.log"), "a");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/runner-main.ts"],
    {
      cwd: root,
      env,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  if (!child.pid) throw new Error("驗收 runner 未能啟動");
  writeFileSync(join(dir, "runner.pid"), String(child.pid));
  child.unref();
  let ready = false;
  for (let n = 0; n < 30; n++) {
    if (await health()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error("驗收 runner 啟動逾時，請查看專用 runner.log");
}
console.log(
  JSON.stringify({
    instance,
    runtime: join(dir, "runtime.json"),
    runner: "已就緒",
    model: "已啟動，首次載入請另外檢查 /health",
    ports,
  }),
);
