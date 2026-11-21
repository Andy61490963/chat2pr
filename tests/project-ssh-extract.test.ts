import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { RunnerCall } from "../server/checks.js";
import type { Database } from "../server/db.js";
import { registerProjectSsh } from "../server/project-ssh.js";

const projectId = "00000000-0000-4000-8000-000000000129";
const url = `/api/projects/${projectId}/ssh-hosts/extract`;
const headers = {
  cookie: "af_session=fictional-session",
  origin: "http://localhost:4310",
  "x-csrf-token": "fictional-csrf",
};
const password = "fictional-lab-password";
const privateKey =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nfictional-key\n-----END OPENSSH PRIVATE KEY-----";
const text = `測試台 lab-a.example.test，帳號 reader，密碼 ${password}，日誌在 C:/logs\n測試台 lab-b.example.test 埠 2222，帳號 observer，私鑰如下\n${privateKey}`;
const drafts = [
  {
    name: "lab-a",
    host: "lab-a.example.test",
    port: null,
    username: "reader",
    password,
    privateKey: null,
    passphrase: null,
    note: "日誌在 C:/logs",
  },
  {
    name: "lab-b",
    host: "lab-b.example.test",
    port: 2222,
    username: "observer",
    password: null,
    privateKey,
    passphrase: null,
    note: null,
  },
];
const results = [
  {
    host: "lab-b.example.test",
    port: 2222,
    reachable: false,
    detail: "這個連接埠拒絕連線",
  },
  { host: "lab-a.example.test", port: 22, reachable: true, detail: "連得到" },
];

async function setup(role: "admin" | "member" = "admin") {
  const db = {
    one: vi.fn(async (sql: string) => {
      if (sql.includes("FROM sessions"))
        return {
          user_id: "1234567",
          csrf: headers["x-csrf-token"],
          login: "fictional-manager",
        };
      if (sql.includes("FROM members")) return { role };
      if (sql.includes("FROM projects")) return { name: "虛構測試專案" };
      throw new Error("收到未預期的資料庫查詢");
    }),
    audit: vi.fn(),
  };
  const ask = vi.fn(
    async (
      _prompt: string,
      _schema: Record<string, unknown>,
    ): Promise<unknown> => ({ hosts: drafts }),
  );
  const call = vi.fn(async () => results);
  const app = Fastify();
  await app.register(cookie);
  registerProjectSsh(
    app,
    db as unknown as Database,
    call as unknown as RunnerCall,
    ask,
  );
  return { app, db, ask, call };
}

it("整理多台 SSH 主機，以原文位址實測並按主機對應結果，活動紀錄只記操作資訊", async () => {
  const { app, db, ask, call } = await setup();
  try {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { text },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json()).toEqual({
      hosts: [
        {
          ...drafts[0],
          port: 22,
          probe: { reachable: true, detail: "連得到" },
        },
        {
          ...drafts[1],
          probe: { reachable: false, detail: "這個連接埠拒絕連線" },
        },
      ],
    });
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining(text),
      expect.any(Object),
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "network/probe",
      {
        targets: [
          { host: "lab-a.example.test", port: 22 },
          { host: "lab-b.example.test", port: 2222 },
        ],
      },
      30000,
    );
    expect(db.audit).toHaveBeenCalledExactlyOnceWith(
      null,
      "project_ssh",
      "管理者 fictional-manager 用 AI 整理專案「虛構測試專案」的 SSH 主機資訊（原文不保存）",
    );
    expect(db.one.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

it("SSH 主機整理拒絕未登入及非管理者請求", async () => {
  const { app, db, ask, call } = await setup("member");
  try {
    const anonymous = await app.inject({
      method: "POST",
      url,
      payload: { text },
    });
    const member = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { text },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(member.statusCode).toBe(403);
    expect(ask).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(db.audit).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("執行器探測失敗時仍回傳草稿，並保留未實測狀態", async () => {
  const { app, call } = await setup();
  call.mockRejectedValueOnce(new Error("虛構執行器無回應"));
  try {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { text },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().hosts).toEqual([
      { ...drafts[0], port: 22, probe: null },
      { ...drafts[1], probe: null },
    ]);
  } finally {
    await app.close();
  }
});

it("同一個連接埠只實測一次，略過原文未提供的位址", async () => {
  const { app, ask, call } = await setup();
  ask.mockResolvedValueOnce({
    hosts: [
      drafts[0],
      { ...drafts[0], name: "lab-a-backup" },
      { ...drafts[1], host: "example.test" },
      { ...drafts[1], name: "lab-c", host: null },
    ],
  });
  try {
    const r = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { text },
    });
    expect(r.statusCode).toBe(200);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "network/probe",
      {
        targets: [{ host: "lab-a.example.test", port: 22 }],
      },
      30000,
    );
    expect(
      r.json().hosts.map((host: { probe: unknown }) => host.probe),
    ).toEqual([
      { reachable: true, detail: "連得到" },
      { reachable: true, detail: "連得到" },
      null,
      null,
    ]);
  } finally {
    await app.close();
  }
});
