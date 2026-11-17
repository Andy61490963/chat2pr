import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { replyError } from "../server/error-reply.js";
import { AppError } from "../server/policy.js";
import { readApiResponse } from "../src/app/api-response.js";

// 不需要資料庫：在 setErrorHandler 之前註冊的路由，用 replyError 也回看板讀得懂的格式。
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function earlyRoutes() {
  const a: FastifyInstance = Fastify({ logger: false });
  app = a;
  const route = { errorHandler: replyError };
  a.put("/zod", route, async (req) =>
    z.object({ port: z.number().min(1, "連接埠請填 1–65535") }).parse(req.body),
  );
  a.post("/app-error", route, async () => {
    throw new AppError(422, "資料庫拒絕登入，請檢查帳號、密碼與資料庫名稱。");
  });
  a.post("/crash", route, async () => {
    throw new Error("內部細節 fictional-secret-value");
  });
  a.post("/default", async () => {
    throw new AppError(422, "資料庫拒絕登入");
  });
  // 和 server/app.ts 一樣：其他路由先註冊，之後才設定全站錯誤處理。
  await a.register(async () => {});
  a.setErrorHandler((_e, _req, reply) => {
    reply.code(418).send({ error: "不會被早先註冊的路由用到" });
  });
  return a;
}

const board = async (res: { statusCode: number; body: string }) =>
  readApiResponse(
    new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": "application/json" },
    }),
  ).catch((e: Error) => e.message);

describe("早先註冊的路由也回看板格式的錯誤", () => {
  it("沒有指定時落到 Fastify 預設格式，看板只看到英文狀態名稱", async () => {
    const a = await earlyRoutes();
    const res = await a.inject({ method: "POST", url: "/default" });
    expect(await board(res)).toBe("Unprocessable Entity");
  });

  it("輸入格式錯誤回 400 與 details，看板顯示具體欄位提示", async () => {
    const a = await earlyRoutes();
    const res = await a.inject({
      method: "PUT",
      url: "/zod",
      payload: { port: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "輸入格式錯誤",
      details: ["port: 連接埠請填 1–65535"],
    });
    expect(await board(res)).toBe("輸入格式錯誤：連接埠請填 1–65535");
  });

  it("AppError 的中文原因放在 error 欄位", async () => {
    const a = await earlyRoutes();
    const res = await a.inject({ method: "POST", url: "/app-error" });
    expect(res.statusCode).toBe(422);
    expect(await board(res)).toBe(
      "資料庫拒絕登入，請檢查帳號、密碼與資料庫名稱。",
    );
  });

  it("內部錯誤回 500 與固定說明，不露出原始訊息", async () => {
    const a = await earlyRoutes();
    const res = await a.inject({ method: "POST", url: "/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("fictional-secret-value");
    expect(res.json()).toEqual({
      error: "服務暫時無法完成操作，請檢查設定與服務狀態",
    });
  });
});
