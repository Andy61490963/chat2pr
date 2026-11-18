import { describe, expect, it } from "vitest";
import {
  expiredMessage,
  probeService,
  readApiResponse,
  SessionExpiredError,
} from "../src/app/api-response.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const html = (status: number) =>
  new Response("<!DOCTYPE html><title>通道錯誤</title>", {
    status,
    headers: { "content-type": "text/html" },
  });

describe("操作中途登入過期", () => {
  it("寫入動作說明剛才的操作沒有完成；讀取只請重新登入", async () => {
    for (const method of ["POST", "PUT", "DELETE", "patch"])
      await expect(
        readApiResponse(new Response("", { status: 401 }), method),
      ).rejects.toThrow("登入已失效，剛才的操作沒有完成，請重新登入。");
    for (const method of ["GET", "HEAD", undefined]) {
      const error = await readApiResponse(
        new Response("", { status: 401 }),
        method,
      ).catch((e: Error) => e);
      expect(error).toBeInstanceOf(SessionExpiredError);
      expect((error as Error).message).toBe("登入已失效，請重新登入。");
    }
    expect(expiredMessage("post")).toBe(
      "登入已失效，剛才的操作沒有完成，請重新登入。",
    );
  });
});

describe("登入頁判斷服務是否連得上", () => {
  const serve =
    (routes: Record<string, Response | Error>) => async (url: string) => {
      const r = routes[url];
      if (r instanceof Error) throw r;
      return r.clone();
    };
  it("status 回 530 HTML 時是連不上（null），不是尚未設定", async () => {
    expect(
      await probeService(
        serve({ "/api/public/status": html(530), "/api/me": html(530) }),
      ),
    ).toEqual({ configured: null, user: null });
    expect(
      await probeService(
        serve({
          "/api/public/status": new TypeError("fetch failed"),
          "/api/me": html(502),
        }),
      ),
    ).toEqual({ configured: null, user: null });
  });
  it("/api/me 回 5xx 或非 JSON 也算連不上", async () => {
    const status = json({ githubConfigured: true });
    expect(
      await probeService(
        serve({ "/api/public/status": status, "/api/me": html(502) }),
      ),
    ).toEqual({ configured: null, user: null });
    expect(
      await probeService(
        serve({
          "/api/public/status": status,
          "/api/me": new Response("<!DOCTYPE html>", {
            headers: { "content-type": "text/html" },
          }),
        }),
      ),
    ).toEqual({ configured: null, user: null });
  });
  it("只有服務回應 githubConfigured=false 才是尚未設定；/api/me 401 只是還沒登入", async () => {
    expect(
      await probeService(
        serve({
          "/api/public/status": json({ githubConfigured: false }),
          "/api/me": json({ error: "請先使用 GitHub 登入" }, 401),
        }),
      ),
    ).toEqual({ configured: false, user: null });
    // 服務以 JSON 拒絕（例如已不在成員名單）是服務在線、只是沒登入。
    expect(
      await probeService(
        serve({
          "/api/public/status": json({ githubConfigured: true }),
          "/api/me": json({ error: "需要管理者權限" }, 403),
        }),
      ),
    ).toEqual({ configured: true, user: null });
    expect(
      await probeService(
        serve({
          "/api/public/status": json({ githubConfigured: true }),
          "/api/me": json({
            login: "fictional-member",
            csrf: "fictional-csrf",
          }),
        }),
      ),
    ).toEqual({
      configured: true,
      user: { login: "fictional-member", csrf: "fictional-csrf" },
    });
  });
});

describe("服務中斷的看板回應", () => {
  it("隧道回 HTML 502 時顯示可理解原因，不顯示代理頁面或原始堆疊", async () => {
    await expect(
      readApiResponse(
        new Response("<!DOCTYPE html><title>代理內部診斷</title>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow("服務暫時無法連線（HTTP 502），請稍後再試。");
  });
  it("成功狀態但內容不是合法 JSON 也不能當成功，服務恢復後可讀取正常資料", async () => {
    await expect(
      readApiResponse(
        new Response("<!DOCTYPE html>", {
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("服務回應格式異常");
    await expect(
      readApiResponse(
        new Response('{"tasks":[]}', {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    ).resolves.toEqual({ tasks: [] });
  });
  it("保留權限與操作錯誤，不因錯誤頁面缺少 JSON 而失去登入判斷", async () => {
    await expect(
      readApiResponse(new Response("拒絕", { status: 401 })),
    ).rejects.toThrow("登入已失效");
    await expect(
      readApiResponse(
        new Response('{"error":"需求版本已改變"}', {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("需求版本已改變");
  });
});

describe("輸入格式錯誤的具體提示", () => {
  const invalid = (details: unknown) =>
    readApiResponse(
      new Response(JSON.stringify({ error: "輸入格式錯誤", details }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
  it("400 帶中文 details 時，去掉欄位路徑後接在錯誤後面", async () => {
    await expect(
      invalid(["host: 主機只能是主機名稱或 IP，不含通訊協定與路徑"]),
    ).rejects.toThrow(
      "輸入格式錯誤：主機只能是主機名稱或 IP，不含通訊協定與路徑",
    );
    await expect(
      invalid(["port: 連接埠請填 1–65535", "ssh.port: SSH 連接埠請填 1–65535"]),
    ).rejects.toThrow(
      "輸入格式錯誤：連接埠請填 1–65535；SSH 連接埠請填 1–65535",
    );
  });
  it("最多只取前三項，重複的提示只顯示一次", async () => {
    const error = await invalid([
      "referenceTables.0: 參考資料表名稱不可包含空白、引號或分號",
      "referenceTables.1: 參考資料表名稱不可包含空白、引號或分號",
      "database: 請填資料庫名稱",
      "username: 請填帳號",
    ]).catch((e: Error) => e.message);
    expect(error).toBe(
      "輸入格式錯誤：參考資料表名稱不可包含空白、引號或分號；請填資料庫名稱",
    );
  });
  it("只有英文預設訊息時只顯示「輸入格式錯誤」，不露出英文與欄位路徑", async () => {
    const error = await invalid([
      'engine: Invalid input: expected "sqlserver"',
      "encrypt: Invalid input: expected boolean, received string",
    ]).catch((e: Error) => e.message);
    expect(error).toBe("輸入格式錯誤");
    const mixed = await invalid([
      "engine: Invalid input",
      "host: 請填主機",
    ]).catch((e: Error) => e.message);
    expect(mixed).toBe("輸入格式錯誤：請填主機");
  });
  it("details 不是字串陣列時照舊只顯示 error", async () => {
    await expect(invalid("host: 請填主機")).rejects.toThrow(/^輸入格式錯誤$/);
    await expect(invalid([{ path: "host" }])).rejects.toThrow(/^輸入格式錯誤$/);
  });
});
