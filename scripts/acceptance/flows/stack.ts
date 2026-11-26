import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import type { Secrets } from "../../../server/config.js";
import { copyAcceptanceLogin } from "../setup.js";
import { acceptanceRunnerReady, acceptanceSetupConfig, pinSubscriptionRelay } from "../setup-config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dbName = "agentflow_b_test";
const instanceLabel = "io.agentflow.instance";
const ownerLabel = "io.agentflow.flow-owner";
const roles = ["default", "subscription", "workers", "install", "ai", "source"] as const;
const appSecretFields = [
  "lineSecret", "lineToken", "discordToken", "discordApplicationId", "githubAppId",
  "githubPrivateKey", "githubClientId", "githubClientSecret", "githubWebhookSecret",
  "githubInstallationId", "sessionSecret",
] as const satisfies readonly (keyof Secrets)[];

export interface FlowStackOptions {
  instance: string;
  scratch: string;
  real: boolean;
  modelOrigin?: string;
  extraSecrets?: Pick<Secrets, (typeof appSecretFields)[number]>;
}

function checkedOptions(options: FlowStackOptions) {
  const { instance, scratch, real, modelOrigin } = options;
  if (!/^verify-266-[a-z0-9][a-z0-9-]{0,43}$/.test(instance))
    throw new Error("流程驗收必須使用新的 verify-266- 實例");
  if (!isAbsolute(scratch)) throw new Error("scratch 必須是專屬根目錄的絕對路徑");
  if (typeof real !== "boolean" || (real && modelOrigin !== undefined))
    throw new Error("真實訂閱模式不得指定假上游");
  const { ports, relayImage } = acceptanceSetupConfig({
    ACCEPTANCE_DB_PORT: "15439",
    ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE: "line-agentflow-subscription-relay:local",
  });
  if (!real) {
    const port = Number(/^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})$/.exec(modelOrigin ?? "")?.[1]);
    if (!(port >= 1024 && port <= 65535) ||
        [4310, 4311, 4312, 4313, 4314, 5439, ports.app, ports.runner, ports.broker, ports.db].includes(port))
      throw new Error("合成訂閱需要獨立的 http://127.0.0.1 高埠上游");
  }
  const extras = z.partialRecord(z.enum(appSecretFields), z.string().min(1)).safeParse(options.extraSecrets ?? {});
  if (!extras.success) throw new Error("extraSecrets 含未允許的欄位或值");
  return { ports, relayImage, extras: extras.data };
}

function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramData"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function protectDirectory(dir: string) {
  // ACL 套用且回讀確認後，才在此目錄寫入任何憑證。
  const script = `
    $ErrorActionPreference = 'Stop'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:FLOW_PRIVATE_DIR -AclObject $acl
    $actual = Get-Acl -LiteralPath $env:FLOW_PRIVATE_DIR
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
        $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or
        $rules[0].FileSystemRights -ne $rule.FileSystemRights -or
        $rules[0].InheritanceFlags -ne $rule.InheritanceFlags) { throw 'ACL' }
  `;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...hostEnvironment(), FLOW_PRIVATE_DIR: dir }, windowsHide: true, stdio: "ignore", timeout: 15000,
    });
  } catch {
    throw new Error("無法設定並確認驗收目錄的 Windows ACL");
  }
}

async function assertPortFree(port: number) {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", () => fail(new Error(`驗收埠 ${port} 無法獨占監聽`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(error => error ? fail(error) : done()));
  });
}

// CLI 與主機 runner 的 Dockerode 固定連到同一個本機引擎。
function docker(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  try {
    return execFileSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", ...args], {
      cwd, env, windowsHide: true, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`驗收 Docker 操作失敗（${args.slice(0, 2).join(" ")}）`);
  }
}

const resourceKinds = ["container", "network", "volume"] as const;
type ResourceKind = (typeof resourceKinds)[number];
type DockerCommand = (args: string[]) => string;
function listed(run: DockerCommand, kind: ResourceKind, filters: string[]) {
  const args = [kind, "ls", ...(kind === "container" ? ["-a", "--no-trunc"] : [])];
  if (kind === "network") args.push("--no-trunc");
  const output = run([...args, ...filters.flatMap(filter => ["--filter", filter]),
    "--format", kind === "volume" ? "{{.Name}}" : "{{.ID}}"]);
  return output ? output.split(/\r?\n/) : [];
}

function assertFresh(run: DockerCommand, instance: string) {
  for (const kind of resourceKinds) {
    for (const filter of [`label=${instanceLabel}=${instance}`, `label=com.docker.compose.project=${instance}`])
      if (listed(run, kind, [filter]).length) throw new Error("驗收實例已有 Docker 資源");
  }
  if (listed(run, "container", [`name=^/${instance}-(db|subscription-relay)-1$`]).length)
    throw new Error("驗收服務的容器名稱已被占用");
  // 同名但缺標籤的資料卷和網路也不能交給 runner 使用。
  for (const kind of ["volume", "network"] as const) {
    for (const prefix of [`^${instance}_`, `^agentflow-${instance}-`])
      if (listed(run, kind, [`name=${prefix}`]).length) throw new Error("驗收實例名稱已有資源");
  }
}

async function startServices(run: DockerCommand, instance: string, owner: string, dir: string) {
  const labels = ["--label", `${instanceLabel}=${instance}`, "--label", `${ownerLabel}=${owner}`];
  const volume = `${instance}_database`;
  run(["volume", "create", ...labels, volume]);
  // volume create 碰到既有名稱會直接回傳它，必須在掛載前認證本次標記。
  if (run(["volume", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, volume]) !== owner)
    throw new Error("資料卷已被其他程序取得");
  for (const role of roles) {
    const internal = role !== "default" && role !== "source";
    const name = `${instance}_${role}`;
    run(["network", "create", ...(internal ? ["--internal"] : []), ...labels, name]);
    if (run(["network", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, name]) !== owner)
      throw new Error("網路名稱未指向本次建立的網路");
  }
  const compose = ["compose", "-f", join(root, "scripts/acceptance/compose.yaml")];
  const service = z.object({ labels: z.record(z.string(), z.string()) }).passthrough();
  const { services } = z.object({ services: z.object({ db: service, "subscription-relay": service }) })
    .parse(JSON.parse(run([...compose, "config", "--format", "json", "db", "subscription-relay"])));
  // 沿用驗收 Compose 的健康檢查、掛載、轉送器權限及網路別名。此專案僅能使用剛建立的卷與網路。
  for (const [name, config] of Object.entries(services)) {
    if (config.labels[instanceLabel] !== instance) throw new Error("驗收 Compose 的服務標記不符");
    config.labels[ownerLabel] = owner;
    config.container_name = `${instance}-${name}-1`;
  }
  const file = join(dir, "compose.json");
  await writeFile(file, JSON.stringify({
    services, volumes: { database: { external: true, name: volume } },
    networks: Object.fromEntries(["default", "subscription"].map(role =>
      [role, { external: true, name: `${instance}_${role}` }])),
  }), { flag: "wx" });
  // 每次使用唯一 Compose 專案；固定容器名稱若被占用，Docker 會拒絕建立。
  run(["compose", "-p", `flow-${owner}`, "-f", file, "up", "-d", "--no-build", "--pull", "never",
    "--no-recreate", "--wait", "--wait-timeout", "60", "db", "subscription-relay"]);
}

function removeResources(run: DockerCommand, instance: string, owner: string, runnerStarted: boolean) {
  const lease = `${instance}_database`;
  const ourLabel = `label=${ownerLabel}=${owner}`;
  // 只有持有本次實例的獨占卷、且確實啟動過 runner，才清它動態建立的工作資源。
  const includeJobs = runnerStarted && listed(run, "volume", [ourLabel]).includes(lease);
  for (const kind of resourceKinds) {
    const filter = includeJobs ? `label=${instanceLabel}=${instance}` : ourLabel;
    const ids = listed(run, kind, [filter]);
    // 容器與網路按完整 ID 移除。最後才釋放充當實例獨占標記的資料卷。
    for (const id of ids.sort((a, b) => Number(a === lease) - Number(b === lease))) {
      const field = kind === "container" ? ".Config.Labels" : ".Labels";
      const labels = JSON.parse(run([kind, "inspect", "--format", `{{json ${field}}}`, id]));
      if (labels?.[instanceLabel] !== instance) continue;
      if (labels[ownerLabel] !== owner) {
        if (!includeJobs || labels[ownerLabel]) continue;
        const managed = labels["io.agentflow.managed"] === "true";
        if (kind === "container" && !(managed && (labels["io.agentflow.run"] || labels["io.agentflow.check"]))) continue;
        if (kind === "volume" && !(managed && id.startsWith(`agentflow-${instance}-`))) continue;
        if (kind === "network" && !(managed && (labels["io.agentflow.check"] || labels["io.agentflow.check-role"] === "egress")) &&
            run([kind, "inspect", "--format", "{{.Name}}", id]) !== `${instance}_open`) continue;
      }
      run([kind, "rm", ...(kind === "container" ? ["-f"] : []), id]);
    }
  }
}

async function checkDatabase(url: string) {
  // 初始化時 pg_isready 可能先連到容器內的暫時 socket；app 要用的是主機 TCP 埠。
  const deadline = Date.now() + 20000;
  for (;;) {
    const db = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000, query_timeout: 2000 });
    try {
      await db.connect();
      const result = await db.query<{ name: string }>("SELECT current_database() AS name");
      if (result.rows[0]?.name !== dbName) throw new Error("資料庫名稱不符");
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (Date.now() >= deadline || !["ECONNREFUSED", "ECONNRESET", "57P03"].includes(String(code)))
        throw error;
    } finally {
      await db.end();
    }
    await delay(250);
  }
}

function launchRunner(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/runner-main.ts"], {
    cwd: root, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const exited = new Promise<void>(done => {
    child.on("error", () => { /* 由監聽及結束狀態回報，避免記錄環境資料。 */ });
    child.once("close", () => done());
  });
  // 兩個 listen 都成功後子程序才印出此行；此時才把新金鑰送往 /health。
  const output = createInterface({ input: child.stdout });
  const listening = new Promise<boolean>(done => {
    output.on("line", line => {
      if (line === `隔離執行器已啟動：${env.RUNNER_URL}`) done(true);
    });
    output.once("close", () => done(false));
  });
  return { child, exited, listening };
}

function running(child: ChildProcess) {
  return !!child.pid && child.exitCode === null && child.signalCode === null;
}

export async function startFlowStack(options: FlowStackOptions) {
  const { ports, relayImage, extras } = checkedOptions(options);
  const { instance, real, modelOrigin } = options;
  if (process.platform !== "win32") throw new Error("流程驗收需要 Windows ACL");
  const scratch = await realpath(options.scratch);
  const dir = join(scratch, instance);
  await mkdir(dir);
  const created = await lstat(dir, { bigint: true });
  const owner = randomBytes(16).toString("hex");
  const runnerKey = randomBytes(32).toString("hex");
  const env = {
    AGENTFLOW_INSTANCE: instance, HOST: "127.0.0.1", PORT: String(ports.app),
    ACCEPTANCE_FLOW_REAL: real ? "1" : "0",
    ADMIN_GITHUB_ID: "266001",
    PUBLIC_URL: `http://127.0.0.1:${ports.app}`, RUNNER_URL: `http://127.0.0.1:${ports.runner}`,
    RUNNER_LISTEN_PORT: String(ports.runner), SUBSCRIPTION_BROKER_PORT: String(ports.broker),
    SUBSCRIPTION_RELAY_URL: "http://subscription-relay:4313",
    SECRETS_FILE: join(dir, "secrets.json"), CODEX_SERVICE_HOME: join(dir, "codex"), DATA_DIR: join(dir, "data"),
    DATABASE_URL: `postgres://agentflowtest:test-only-password@127.0.0.1:${ports.db}/${dbName}`,
    SOURCE_CACHE_IMAGE: "line-agentflow-source:local",
    EMBEDDER_URL: `http://127.0.0.1:${ports.app}/unused-embedder`,
    ...(!real && modelOrigin ? { ACCEPTANCE_MODEL_ORIGIN: modelOrigin } : {}),
  };
  const dockerEnv = {
    ...hostEnvironment(), AGENTFLOW_INSTANCE: instance, COMPOSE_DISABLE_ENV_FILE: "1",
    ACCEPTANCE_DB_NAME: dbName, ACCEPTANCE_DB_PORT: String(ports.db),
    ACCEPTANCE_SUBSCRIPTION_BROKER_PORT: String(ports.broker), ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE: relayImage,
    // 原始 Compose 在篩選 profile 前做字串插值；這個名字只供解析，不會建立或掛載。
    ACCEPTANCE_MODEL_VOLUME: `${instance}_unused`,
    DOCKER_CONFIG: join(dir, "docker-config"),
  };
  const run: DockerCommand = args => docker(args, dockerEnv, dir);
  let creating = false;
  let runnerStarted = false;
  let runner: ReturnType<typeof launchRunner> | undefined;
  async function stopRunner() {
    if (runner) {
      if (running(runner.child)) runner.child.kill();
      if (!await Promise.race([runner.exited.then(() => true), delay(10000, false, { ref: false })]))
        throw new Error("無法確認本次主機執行器已停止");
      runner = undefined;
    }
  }
  async function startRunner() {
    runner = launchRunner({ ...hostEnvironment(), ...env });
    runnerStarted ||= !!runner.child.pid;
    if (!await Promise.race([runner.listening, delay(45000, false, { ref: false })]) || !running(runner.child))
      throw new Error("本次主機執行器未完成監聽");
    if (!await acceptanceRunnerReady(env.RUNNER_URL, runnerKey, instance, 5000) || !running(runner.child))
      throw new Error("本次主機執行器未通過健康檢查");
    return z.int().positive().parse(runner.child.pid);
  }
  async function restart(runId: string) {
    if (real || !runner || !running(runner.child)) throw new Error("沒有可重啟的本次固定劇本執行器");
    z.uuid().parse(runId);
    if (run(["volume", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, `${instance}_database`]) !== owner ||
        !listed(run, "container", [`label=${instanceLabel}=${instance}`, "label=io.agentflow.managed=true",
          `label=io.agentflow.run=${runId}`, "status=running"]).length)
      throw new Error("無法確認本實例與指定工作容器的歸屬");
    const previousPid = z.int().positive().parse(runner.child.pid);
    await stopRunner();
    for (const port of [ports.runner, ports.broker]) await assertPortFree(port);
    const pid = await startRunner();
    return { instance, previousPid, pid };
  }
  let restarting: ReturnType<typeof restart> | undefined;
  async function restartRunner(runId: string) {
    if (closing || restarting) throw new Error("執行器正在重啟或驗收環境正在關閉");
    restarting = restart(runId);
    try { return await restarting; } finally { restarting = undefined; }
  }
  async function cleanup() {
    await restarting?.catch(() => {});
    await stopRunner();
    const current = await lstat(dir, { bigint: true });
    if (!current.isDirectory() || current.ino !== created.ino || current.dev !== created.dev ||
        (await realpath(dir)) !== dir || dirname(dir) !== scratch)
      throw new Error("驗收目錄身分已變更，無法安全移除");
    await rm(env.CODEX_SERVICE_HOME, { recursive: true, force: true, maxRetries: 3 });
    await rm(env.SECRETS_FILE, { force: true, maxRetries: 3 });
    if (creating) {
      for (let attempt = 0; ; attempt++) {
        try {
          removeResources(run, instance, owner, runnerStarted);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await delay(250);
        }
      }
      creating = false;
    }
    await rm(dir, { recursive: true, maxRetries: 3, retryDelay: 150 });
  }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= cleanup().catch(error => {
    closing = undefined;
    throw error;
  });
  try {
    protectDirectory(dir);
    for (const port of [ports.app, ports.runner, ports.broker, ports.db]) await assertPortFree(port);
    await mkdir(dockerEnv.DOCKER_CONFIG);
    if (process.env.ProgramFiles) {
      const plugins = join(process.env.ProgramFiles, "Docker", "Docker", "resources", "cli-plugins");
      await writeFile(join(dockerEnv.DOCKER_CONFIG, "config.json"),
        JSON.stringify({ cliPluginsExtraDirs: [plugins] }), { flag: "wx" });
    }
    assertFresh(run, instance);
    dockerEnv.ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE = pinSubscriptionRelay(
      JSON.parse(run(["image", "inspect", relayImage])),
    );
    creating = true;
    await startServices(run, instance, owner, dir);
    await checkDatabase(env.DATABASE_URL);
    await mkdir(env.CODEX_SERVICE_HOME);
    await mkdir(env.DATA_DIR);
    await writeFile(env.SECRETS_FILE, JSON.stringify({ ...extras, runnerSecret: runnerKey }), { flag: "wx" });
    if (real) copyAcceptanceLogin(env.CODEX_SERVICE_HOME, true);
    else await writeFile(join(env.CODEX_SERVICE_HOME, "auth.json"),
      JSON.stringify({ tokens: { access_token: "AcceptanceModelToken266", account_id: "AcceptanceAccount266" } }), { flag: "wx" });
    await startRunner();
    return { instance, dir, env: { ...env }, runnerKey, restartRunner, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "驗收啟動失敗且清理未完成"); }
    throw error;
  }
}

export type FlowStack = Awaited<ReturnType<typeof startFlowStack>>;
