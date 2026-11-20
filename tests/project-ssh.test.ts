import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Server, utils } from "ssh2";
import type { AddressInfo } from "node:net";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import type { Runner } from "../server/execution.js";
import { FULL_ACCESS_ENV } from "../server/containers.js";
import {
  fullAccessEnvironment,
  fullAccessNote,
} from "../server/full-access.js";
import { testSshLogin } from "../server/ssh-login.js";
import {
  describe as describeHosts,
  fingerprintOf,
  matchingKnownHost,
  scpArgs,
  sshArgs,
  commonOptions,
} from "../worker/ssh-hosts.mjs";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ sessionSecret: "fictional-session-secret-for-tests" }),
}));

// 全部是虛構帳密與位址。
const password = "Fictional-Ssh-Pass-456";
beforeEach(reset);
afterAll(() => db.close());

function fakeRunner() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const runner = {
    async call<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body: body as Record<string, unknown> });
      if (path === "ssh/test")
        return {
          ok: true,
          detail: "登入成功",
          hostKey: "SHA256:fictional-host-key",
        } as T;
      throw new Error(`沒有預期的呼叫：${path}`);
    },
  } as Pick<Runner, "call">;
  return { runner, calls };
}

describe("專案的 SSH 主機", () => {
  it("只有管理者能登記；密碼不回傳、不進活動紀錄；測試登入記下主機金鑰", async () => {
    const projectId = await fixture();
    const { runner, calls } = fakeRunner();
    const app = await buildApp(db, undefined, undefined, undefined, runner);
    try {
      const url = `/api/projects/${projectId}/ssh-hosts`;
      const body = {
        name: "jet-u01",
        host: "10.0.7.31",
        username: "reader",
        password,
        note: "U01 工控電腦",
      };
      const anonymous = await app.inject({
        method: "POST",
        url,
        payload: body,
      });
      expect(anonymous.statusCode).toBe(401);

      const headers = await session();
      const created = await app.inject({
        method: "POST",
        url,
        headers,
        payload: body,
      });
      expect(created.statusCode).toBe(200);
      const [host] = created.json();
      expect(host).toMatchObject({
        name: "jet-u01",
        host: "10.0.7.31",
        port: 22,
        username: "reader",
        auth: "password",
        hostKey: null,
      });
      expect(created.body).not.toContain(password);

      const duplicate = await app.inject({
        method: "POST",
        url,
        headers,
        payload: body,
      });
      expect(duplicate.statusCode).toBe(409);
      const badName = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...body, name: "有空白 的名稱" },
      });
      expect(badName.statusCode).toBe(400);

      const tested = await app.inject({
        method: "POST",
        url: `${url}/${host.id}/test`,
        headers,
      });
      expect(tested.json()).toEqual({ ok: true, detail: "登入成功" });
      expect(calls.find((c) => c.path === "ssh/test")).toEqual({
        path: "ssh/test",
        body: {
          host: "10.0.7.31",
          port: 22,
          username: "reader",
          password,
          hostKey: null,
        },
      });
      const list = await app.inject({ method: "GET", url, headers });
      expect(list.json()[0].hostKey).toBe("SHA256:fictional-host-key");

      // 只改用途說明：沿用原本的密碼與主機金鑰；改了位址就要重新核對。
      const noteOnly = await app.inject({
        method: "PUT",
        url: `${url}/${host.id}`,
        headers,
        payload: { ...body, password: undefined, note: "改過的說明" },
      });
      expect(noteOnly.json()[0]).toMatchObject({
        note: "改過的說明",
        hostKey: "SHA256:fictional-host-key",
      });
      const moved = await app.inject({
        method: "PUT",
        url: `${url}/${host.id}`,
        headers,
        payload: { ...body, password: undefined, host: "10.0.7.32" },
      });
      expect(moved.json()[0].hostKey).toBeNull();
      const access = await fullAccessEnvironment(db, projectId);
      expect(access.env[0]).toContain(password);

      const audit = await db.query<{ detail: string }>(
        "SELECT detail FROM audit WHERE kind='project_ssh' ORDER BY id",
      );
      expect(audit.map((a) => a.detail)).toEqual([
        "已登記專案「測試專案」的 SSH 主機 jet-u01（reader@10.0.7.31:22）",
        "已更新專案「測試專案」的 SSH 主機 jet-u01（reader@10.0.7.31:22）",
        "已更新專案「測試專案」的 SSH 主機 jet-u01（reader@10.0.7.32:22）",
      ]);
      expect(JSON.stringify(audit)).not.toContain(password);

      const removed = await app.inject({
        method: "DELETE",
        url: `${url}/${host.id}`,
        headers,
      });
      expect(removed.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("完全存取把主機交給容器；說明只列名稱與位址，不含密碼", async () => {
    const projectId = await fixture();
    const { runner } = fakeRunner();
    const app = await buildApp(db, undefined, undefined, undefined, runner);
    try {
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/ssh-hosts`,
        headers: await session(),
        payload: {
          name: "jet-u01",
          host: "10.0.7.31",
          username: "reader",
          password,
          note: "U01 工控電腦",
        },
      });
    } finally {
      await app.close();
    }
    const access = await fullAccessEnvironment(db, projectId);
    expect(access.database).toBe(false);
    expect(access.env).toHaveLength(1);
    expect(FULL_ACCESS_ENV.test(access.env[0])).toBe(true);
    const hosts = JSON.parse(
      access.env[0].slice("AGENTFLOW_SSH_HOSTS=".length),
    );
    expect(hosts).toEqual([
      {
        name: "jet-u01",
        host: "10.0.7.31",
        port: 22,
        username: "reader",
        note: "U01 工控電腦",
        hostKey: null,
        password,
      },
    ]);
    expect(access.secrets).toContain(password);
    const note = fullAccessNote(access);
    expect(note).toContain("jet-u01（reader@10.0.7.31:22，U01 工控電腦）");
    expect(note).toContain("agentflow-ssh <名稱> <命令>");
    expect(note).not.toContain(password);
  });
});

describe("agentflow-ssh", () => {
  const host = {
    name: "jet-u01",
    host: "10.0.7.31",
    port: 2222,
    username: "reader",
    password,
  };
  it("只信任和登記指紋相同的主機金鑰", () => {
    const keyA = Buffer.from("fictional-key-a").toString("base64");
    const keyB = Buffer.from("fictional-key-b").toString("base64");
    const scan = `# 註解\n[10.0.7.31]:2222 ssh-rsa ${keyA}\n[10.0.7.31]:2222 ssh-ed25519 ${keyB}\n`;
    expect(matchingKnownHost(scan, fingerprintOf(keyB))).toBe(
      `[10.0.7.31]:2222 ssh-ed25519 ${keyB}`,
    );
    // ssh-keygen 的指紋不帶補位等號，也要認得。
    expect(
      matchingKnownHost(scan, fingerprintOf(keyA).replace(/=+$/, "")),
    ).toContain("ssh-rsa");
    expect(matchingKnownHost(scan, "SHA256:other")).toBeUndefined();
  });

  it("命令列不含密碼；scp 以冒號開頭的路徑代表遠端", () => {
    const options = commonOptions(host, "/tmp/k", true);
    expect(options).toContain("StrictHostKeyChecking=yes");
    // 只提供 ssh-rsa 的舊設備也要連得上（10.3.x 的機台實測如此）。
    expect(options).toContain("HostKeyAlgorithms=+ssh-rsa");
    const ssh = sshArgs(host, options, undefined, ["dir", "C:\\logs"]);
    expect(ssh.slice(-4)).toEqual([
      "2222",
      "reader@10.0.7.31",
      "--",
      "dir C:\\logs",
    ]);
    const scp = scpArgs(host, options, "/tmp/key", [
      ":C:/logs/app.log",
      "/tmp/",
    ]);
    expect(scp.slice(-6)).toEqual([
      "/tmp/key",
      "-P",
      "2222",
      "-r",
      "reader@10.0.7.31:C:/logs/app.log",
      "/tmp/",
    ]);
    expect(JSON.stringify([...ssh, ...scp])).not.toContain(password);
    expect(describeHosts([host])).not.toContain(password);
    expect(commonOptions(host, "/tmp/k", false)).toContain(
      "StrictHostKeyChecking=accept-new",
    );
  });
});

describe("從主機測試 SSH 登入", () => {
  let server: Server | undefined;
  afterAll(() => server?.close());
  it("登入成功回報指紋；密碼錯誤與金鑰不符各自說明", async () => {
    const hostKey = utils.generateKeyPairSync("ed25519");
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on("authentication", (ctx) =>
        ctx.method === "password" &&
        ctx.username === "reader" &&
        ctx.password === password
          ? ctx.accept()
          : ctx.reject(["password"]),
      );
      client.on("ready", () => client.end());
      client.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const base = { host: "127.0.0.1", port, username: "reader" };
    const ok = await testSshLogin({ ...base, password });
    expect(ok.ok).toBe(true);
    expect(ok.hostKey).toMatch(/^SHA256:/);
    expect(
      await testSshLogin({ ...base, password, hostKey: ok.hostKey }),
    ).toMatchObject({ ok: true });
    const wrong = await testSshLogin({ ...base, password: "wrong" });
    expect(wrong).toEqual({
      ok: false,
      detail: "主機拒絕登入，請檢查帳號、密碼或私鑰。",
    });
    const spoofed = await testSshLogin({
      ...base,
      password,
      hostKey: "SHA256:different",
    });
    expect(spoofed.ok).toBe(false);
    expect(spoofed.detail).toContain("主機金鑰和上次登入時不同");
  });
});
