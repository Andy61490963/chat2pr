import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import type { Runner } from "../server/execution.js";
import { probeOne } from "../server/network-probe.js";
import { extractResult, probeList } from "../server/connection-extract.js";
import { subscriptionGateName } from "../server/subscription-gate.js";

// 全部是虛構憑證與位址。
const password = "Fictional-Mes-Pass-321";
const parsed = {
  connection: {
    host: "100.64.0.10",
    port: null,
    database: "MES_TEST",
    username: "mes_reader",
    password,
    encrypt: null,
    trustServerCertificate: null,
    ssh: null,
  },
  endpoints: [{ host: "10.3.1.7", port: 8096, purpose: "廠內看板" }],
  vpn: { needed: true, note: "要先連公司 VPN 才到得了 10.3.1.x" },
  notes: ["帳號名稱看起來是唯讀，請確認"],
};

beforeEach(reset);
afterAll(() => db.close());

describe("用白話描述連線", () => {
  it("AI 整理成欄位、主機實測位址；只有管理者能用，原文與密碼不進活動紀錄", async () => {
    const projectId = await fixture();
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
    );
    await db.query(
      "INSERT INTO service_health(name,ok,detail,checked_at) VALUES($1,true,'Codex 訂閱額度可用',clock_timestamp()) ON CONFLICT(name) DO UPDATE SET ok=true,checked_at=clock_timestamp()",
      [subscriptionGateName],
    );
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const runner = {
      async call<T>(path: string, body: unknown): Promise<T> {
        calls.push({ path, body: body as Record<string, unknown> });
        if (path === "ai")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ final: JSON.stringify(parsed) }),
            stderr: "",
          } as T;
        if (path === "network/probe")
          return [
            {
              host: "100.64.0.10",
              port: 1433,
              reachable: true,
              detail: "連得到（12 ms）",
            },
            {
              host: "10.3.1.7",
              port: 8096,
              reachable: false,
              detail: "5 秒內沒有回應",
            },
          ] as T;
        throw new Error(`沒有預期的呼叫：${path}`);
      },
    } as Pick<Runner, "call">;
    const app = await buildApp(db, undefined, undefined, undefined, runner);
    try {
      const url = `/api/projects/${projectId}/database/extract`;
      const text = `MES 測試庫在 100.64.0.10，資料庫 MES_TEST，帳號 mes_reader 密碼 ${password}；看板 http://10.3.1.7:8096 要先連 VPN`;
      const anonymous = await app.inject({
        method: "POST",
        url,
        payload: { text },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(calls).toHaveLength(0);

      const r = await app.inject({
        method: "POST",
        url,
        headers: await session(),
        payload: { text },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.connection).toMatchObject({
        host: "100.64.0.10",
        database: "MES_TEST",
        username: "mes_reader",
        password,
      });
      expect(body.endpoints).toEqual([
        {
          host: "100.64.0.10",
          port: 1433,
          purpose: "資料庫",
          reachable: true,
          detail: "連得到（12 ms）",
        },
        {
          host: "10.3.1.7",
          port: 8096,
          purpose: "廠內看板",
          reachable: false,
          detail: "5 秒內沒有回應",
        },
      ]);
      expect(body.vpn.needed).toBe(true);
      // AI 拿到原文；主機實測只送位址。
      expect(
        String(
          calls[0].body.job && (calls[0].body.job as { prompt: string }).prompt,
        ),
      ).toContain(password);
      expect(calls[1]).toEqual({
        path: "network/probe",
        body: {
          targets: [
            { host: "100.64.0.10", port: 1433 },
            { host: "10.3.1.7", port: 8096 },
          ],
        },
      });
      const audit = await db.query<{ detail: string }>(
        "SELECT detail FROM audit WHERE kind='project_database'",
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].detail).toContain("原文不保存");
      expect(JSON.stringify(audit)).not.toContain(password);
      // 不會自動儲存連線。
      expect(
        await db.one("SELECT 1 FROM project_connections WHERE project_id=$1", [
          projectId,
        ]),
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("經 SSH 跳板的資料庫不從主機直接實測，位址不重複", () => {
    const viaSsh = {
      ...parsed,
      connection: {
        ...parsed.connection,
        ssh: {
          host: "jump.example.test",
          port: 22,
          username: "ops",
          password: null,
        },
      },
      endpoints: [
        { host: "10.3.1.7", port: 8096, purpose: "看板" },
        { host: "10.3.1.7", port: 8096, purpose: "看板（重複）" },
      ],
    };
    expect(probeList(viaSsh)).toEqual([{ host: "10.3.1.7", port: 8096 }]);
    expect(extractResult(viaSsh, []).endpoints).toEqual([
      {
        host: "10.3.1.7",
        port: 8096,
        purpose: "看板",
        reachable: false,
        detail: "沒有實測",
      },
    ]);
  });
});

describe("從主機實測位址", () => {
  let server: Server | undefined;
  afterAll(() => server?.close());
  it("連得到與拒絕連線各自說明原因", async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const open = await probeOne("127.0.0.1", port);
    expect(open.reachable).toBe(true);
    expect(open.detail).toMatch(/^連得到/);
    const closed = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const refused = await probeOne("127.0.0.1", closed);
    expect(refused.reachable).toBe(false);
    expect(refused.detail).toBe("主機有回應，但這個連接埠拒絕連線");
  });
});
