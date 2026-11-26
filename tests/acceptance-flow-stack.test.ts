import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFlowStack, type FlowStackOptions } from "../scripts/acceptance/flows/stack.js";

const host = vi.hoisted(() => ({
  command: vi.fn<(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => string>(),
  spawn: vi.fn(), listen: vi.fn(), database: vi.fn(), health: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: host.command, spawn: host.spawn }));
vi.mock("node:net", async original => ({
  ...await original<typeof import("node:net")>(),
  createServer: () => Object.assign(new EventEmitter(), {
    listen: host.listen, close: (callback: () => void) => callback(),
  }),
}));
vi.mock("pg", () => ({ default: { Client: class {
  connect() {}
  query = host.database;
  end() {}
} } }));

const instance = "verify-266-unit", modelOrigin = "http://127.0.0.1:54166";
const instanceLabel = "io.agentflow.instance", ownerLabel = "io.agentflow.flow-owner";
const image = `sha256:${"a".repeat(64)}`;
const root = resolve(tmpdir());
const base = { instance, modelOrigin, scratch: root, real: false };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([
  { instance: "production" }, { instance: "verify-266-" }, { instance: "verify-266-../login" },
  { scratch: "relative" }, { real: true }, { modelOrigin: undefined },
  { modelOrigin: "http://127.0.0.1:4313" }, { modelOrigin: "http://127.0.0.1:14312" },
  { modelOrigin: "http://127.0.0.1:65536" }, { modelOrigin: "https://example.invalid:54166" },
  { modelOrigin: "http://127.0.0.1:54166/redirect" },
  { extraSecrets: { runnerSecret: "不可取代", sessionSecret: "合成" } },
  { extraSecrets: { publicUrl: "https://example.invalid", lineToken: "合成" } },
  { extraSecrets: { tunnelProvider: "external", openaiKey: "合成", githubAppId: "266" } },
])("拒絕不安全的輸入，尚未執行主機指令（%#）", async overrides => {
  await expect(startFlowStack({ ...base, ...overrides })).rejects.toThrow();
  expect(host.command).not.toHaveBeenCalled();
  expect(host.spawn).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("無法使用 Windows ACL 時直接拒絕", async () => {
  await expect(startFlowStack(base)).rejects.toThrow("Windows ACL");
  expect(host.command).not.toHaveBeenCalled();
});

type Kind = "volume" | "network" | "container";
type Resource = { kind: Kind; id: string; name: string; labels: Record<string, string> };

// 只模擬外部主機協定；每個案例的憑證、副本與目錄排他性均經過真正檔案系統。
describe.skipIf(process.platform !== "win32")("隔離流程生命週期", () => {
  let scratch: string, dir: string, input: FlowStackOptions;
  let resources: Resource[], stopped: ReturnType<typeof vi.fn>;
  let failAt: "acl" | "compose" | "volume" | "listen" | undefined;
  let childEnv: NodeJS.ProcessEnv;
  const add = (kind: Kind, name: string, labels: Resource["labels"]) => {
    const id = kind === "volume" ? name : `id-${name}`;
    resources.push({ kind, name, labels, id });
  };
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(root, "flow-stack-test-")));
    dir = join(scratch, instance);
    input = { ...base, scratch };
    resources = [];
    failAt = undefined;
    add("container", "其他實例", { [instanceLabel]: "verify-266-other", "io.agentflow.managed": "true" });
    host.listen.mockImplementation((_opts, done) => done());
    host.database.mockResolvedValue({ rows: [{ name: "agentflow_b_test" }] });
    host.health.mockImplementation(async () => Response.json({ ok: true, instance, subscriptionBroker: "v1" }));
    vi.stubGlobal("fetch", host.health);
    vi.stubEnv("ACCEPTANCE_MODEL_ORIGIN", "http://127.0.0.1:4313");
    vi.stubEnv("OPENAI_API_KEY", "fictional-host-key");
    vi.stubEnv("ACCEPTANCE_AUTH_SOURCE", join(scratch, "unused-login"));
    host.spawn.mockImplementation((_file, _args, opts) => {
      childEnv = opts.env;
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout, pid: 12345, exitCode: null as number | null, signalCode: null,
        kill: vi.fn((): boolean => { child.exitCode = 0; stdout.end(); child.emit("close"); return true; }),
      });
      stopped = child.kill;
      queueMicrotask(() => {
        if (failAt === "listen") { child.exitCode = 1; stdout.end(); child.emit("close"); }
        else stdout.write(`隔離執行器已啟動：${opts.env.RUNNER_URL}\n`);
      });
      return child;
    });
    host.command.mockImplementation((file, allArgs, opts) => {
      if (file === "powershell.exe") {
        expect(opts.env.FLOW_PRIVATE_DIR).toBe(dir);
        expect(existsSync(join(dir, "secrets.json"))).toBe(false);
        if (failAt === "acl") throw new Error("拒絕套用權限");
        return "";
      }
      expect(file).toBe("docker");
      expect(allArgs.slice(0, 2)).toEqual(["--host", "npipe:////./pipe/dockerDesktopLinuxEngine"]);
      expect(opts.env).not.toHaveProperty("ACCEPTANCE_AUTH_SOURCE");
      const [kind, action, ...args] = allArgs.slice(2);
      const last = args.at(-1)!;
      if (kind === "image" && action === "inspect")
        return JSON.stringify([{ Id: image, Config: { Labels: { "io.agentflow.subscription-relay": "v1" } } }]);
      if (kind === "compose") {
        if (args.includes("config")) return JSON.stringify({ services: {
          db: { image: "pgvector/pgvector:pg17", labels: { [instanceLabel]: instance } },
          "subscription-relay": { image: opts.env.ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE, labels: { [instanceLabel]: instance } },
        } });
        expect(args).toContain("--no-build");
        expect(args.slice(args.indexOf("--pull"), args.indexOf("--pull") + 2)).toEqual(["--pull", "never"]);
        const config = JSON.parse(readFileSync(join(dir, "compose.json"), "utf8"));
        expect(Object.keys(config.services).sort()).toEqual(["db", "subscription-relay"]);
        expect(Object.keys(config.volumes)).toEqual(["database"]);
        expect(config.services["subscription-relay"].image).toBe(image);
        add("container", "驗收資料庫", config.services.db.labels);
        if (failAt === "compose") throw new Error("轉送器啟動失敗");
        add("container", "驗收轉送器", config.services["subscription-relay"].labels);
        return "";
      }
      if (kind !== "network" && kind !== "container" && kind !== "volume") throw new Error("非預期資源種類");
      if (action === "ls") {
        let found = resources.filter(r => r.kind === kind);
        for (const [i, arg] of args.entries()) {
          if (arg !== "--filter") continue;
          const [type, key, val] = args[i + 1].split("=");
          if (type === "label") found = found.filter(r => r.labels[key] === val);
          else if (type === "name") found = found.filter(r => new RegExp(key).test(r.name));
          else throw new Error("非預期篩選");
        }
        return found.map(r => r.id).join("\n");
      }
      if (action === "create") {
        const labels: Record<string, string> = {};
        for (const [i, arg] of args.entries()) if (arg === "--label") {
          const [key, val] = args[i + 1].split("=");
          labels[key] = val;
        }
        if (kind === "volume" && failAt === "volume") labels[ownerLabel] = "同時啟動的程序";
        add(kind, last, labels);
        return kind === "volume" ? last : `id-${last}`;
      }
      const resource = resources.find(r => r.kind === kind && (r.id === last || r.name === last));
      if (!resource) throw new Error("資源不存在");
      if (action === "inspect") {
        if (args.includes("{{.Name}}")) return resource.name;
        if (args.some(arg => arg.startsWith("{{index"))) return resource.labels[ownerLabel];
        return JSON.stringify(resource.labels);
      }
      if (action !== "rm") throw new Error("非預期操作");
      resources.splice(resources.indexOf(resource), 1);
      return "";
    });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("交回就緒的獨立環境，只用假訂閱憑證，重複關閉保留其他實例", async () => {
    const stack = await startFlowStack({ ...input, extraSecrets: { githubWebhookSecret: "fixture-webhook" } });
    try {
      expect(stack.env).toMatchObject({ PORT: "14310", RUNNER_LISTEN_PORT: "14312", SUBSCRIPTION_BROKER_PORT: "14313",
        ACCEPTANCE_MODEL_ORIGIN: modelOrigin, PUBLIC_URL: "http://127.0.0.1:14310" });
      expect(stack.env.DATABASE_URL).toMatch(/@127\.0\.0\.1:15439\/agentflow_b_test$/);
      expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
      expect(childEnv).not.toHaveProperty("ACCEPTANCE_AUTH_SOURCE");
      expect(stack.dir).toBe(dir);
      expect(stack.runnerKey).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(await readFile(stack.env.SECRETS_FILE, "utf8"))).toEqual({
        runnerSecret: stack.runnerKey, githubWebhookSecret: "fixture-webhook",
      });
      expect(JSON.parse(await readFile(join(stack.env.CODEX_SERVICE_HOME, "auth.json"), "utf8"))).toEqual({
        tokens: { access_token: "AcceptanceModelToken266", account_id: "AcceptanceAccount266" },
      });
      expect(host.health).toHaveBeenCalledWith("http://127.0.0.1:14312/health",
        expect.objectContaining({ headers: { "x-runner-key": stack.runnerKey }, redirect: "error" }));
      add("volume", `agentflow-${instance}-job-fixture`, { [instanceLabel]: instance, "io.agentflow.managed": "true" });
      add("volume", "非工作卷", { [instanceLabel]: instance });
      add("container", "本次工作容器", {
        [instanceLabel]: instance, "io.agentflow.managed": "true", "io.agentflow.run": "虛構工作",
      });
      // 呼叫端調整交給 app 的副本也不能改變 close 的清理範圍。
      stack.env.CODEX_SERVICE_HOME = join(scratch, "旁邊的目錄");
      await mkdir(stack.env.CODEX_SERVICE_HOME);
    } finally {
      await Promise.all([stack.close(), stack.close()]);
    }
    await stack.close();
    expect(stopped).toHaveBeenCalledOnce();
    expect(resources.map(r => r.name)).toEqual(["其他實例", "非工作卷"]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(scratch, "旁邊的目錄"))).toBe(true);
  });

  it("真實模式只複製指定的訂閱檔，排除繼承的假上游，清理保留原檔", async () => {
    const source = join(scratch, "fictional-login");
    const raw = JSON.stringify({ tokens: { access_token: "FictionalSubscription", account_id: "FictionalAccount" } });
    await writeFile(source, raw);
    vi.stubEnv("ACCEPTANCE_AUTH_SOURCE", source);
    const stack = await startFlowStack({ ...input, real: true, modelOrigin: undefined });
    try {
      expect(stack.env.ACCEPTANCE_FLOW_REAL).toBe("1");
      expect(childEnv).not.toHaveProperty("ACCEPTANCE_MODEL_ORIGIN");
      expect(await readFile(join(stack.env.CODEX_SERVICE_HOME, "auth.json"), "utf8")).toBe(raw);
    } finally { await stack.close(); }
    expect(await readFile(source, "utf8")).toBe(raw);
    expect(existsSync(dir)).toBe(false);
  });

  it("既有目錄或同實例舊工作都拒絕認領", async () => {
    await mkdir(dir);
    await expect(startFlowStack(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(existsSync(dir)).toBe(true);
    expect(host.command).not.toHaveBeenCalled();
    await rm(dir, { recursive: true });
    add("container", "舊工作", { [instanceLabel]: instance, "io.agentflow.managed": "true" });
    await expect(startFlowStack(input)).rejects.toThrow("已有 Docker 資源");
    expect(resources.map(r => r.name)).toEqual(["其他實例", "舊工作"]);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it.each(["acl", "compose", "listen"] as const)("啟動在 %s 中斷只清理此次新增資源", async stage => {
    failAt = stage;
    await expect(startFlowStack(input)).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(resources.map(r => r.name)).toEqual(["其他實例"]);
    expect(host.health).not.toHaveBeenCalled();
  });

  it("資料卷名稱競爭不掛載也不刪除先取得名稱的程序資源", async () => {
    failAt = "volume";
    await expect(startFlowStack(input)).rejects.toThrow("其他程序");
    expect(resources.map(r => r.name)).toEqual(["其他實例", `${instance}_database`]);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it("埠已占用時不向舊程序送出金鑰，也不嘗試取得 Docker 資源", async () => {
    host.listen.mockImplementationOnce(function (this: EventEmitter) {
      this.emit("error", new Error("EADDRINUSE"));
    });
    await expect(startFlowStack(input)).rejects.toThrow("無法獨占監聽");
    expect(host.command.mock.calls.map(([file]) => file)).toEqual(["powershell.exe"]);
    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.health).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it("真實模式拒絕 API 金鑰，保留來源且回收已啟動的服務", async () => {
    const source = join(scratch, "fictional-key");
    await writeFile(source, JSON.stringify({ OPENAI_API_KEY: "FictionalKey" }));
    vi.stubEnv("ACCEPTANCE_AUTH_SOURCE", source);
    await expect(startFlowStack({ ...input, real: true, modelOrigin: undefined }))
      .rejects.toThrow("登入格式");
    expect(host.spawn).not.toHaveBeenCalled();
    expect(existsSync(source)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(resources.map(r => r.name)).toEqual(["其他實例"]);
  });

  it("DB 身分或 runner 健康檢查失敗時回收部分啟動的 stack", async () => {
    host.database.mockResolvedValueOnce({ rows: [{ name: "other_test" }] });
    await expect(startFlowStack(input)).rejects.toThrow("資料庫名稱不符");
    expect(host.spawn).not.toHaveBeenCalled();
    host.health.mockResolvedValueOnce(Response.json({ ok: true, instance: "verify-other" }));
    await expect(startFlowStack(input)).rejects.toThrow("健康執行器");
    expect(stopped).toHaveBeenCalledOnce();
    expect(existsSync(dir)).toBe(false);
    expect(resources.map(r => r.name)).toEqual(["其他實例"]);
  });
});
