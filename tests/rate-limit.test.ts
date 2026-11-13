import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { db, reset } from "./helpers.js";
import { buildApp } from "../server/app.js";
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  app = await buildApp(db);
});
afterEach(() => app.close());
afterAll(() => db.close());

// 剩餘額度由回應標頭觀察；通道轉進來的連線在服務端看起來都來自本機。
const remaining = async (forwarded?: string, remoteAddress = "127.0.0.1") => {
  const response = await app.inject({
    url: "/api/public/status",
    remoteAddress,
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
  });
  return Number(response.headers["x-ratelimit-remaining"]);
};

it("經通道進來的不同用戶端各自計算流量額度", async () => {
  expect(await remaining("203.0.113.1")).toBe(239);
  expect(await remaining("203.0.113.1")).toBe(238);
  expect(await remaining("203.0.113.2")).toBe(239);
  // 沒有經過通道的本機連線自成一組。
  expect(await remaining()).toBe(239);
});

it("用戶端自己填的轉送位址不能換身分躲開限制", async () => {
  expect(await remaining("203.0.113.1")).toBe(239);
  expect(await remaining("198.51.100.9, 203.0.113.1")).toBe(238);
  expect(await remaining("198.51.100.10, 203.0.113.1")).toBe(237);
  // 最後一段不是位址時退回連線來源，不會各開一組額度。
  expect(await remaining("亂填一")).toBe(239);
  expect(await remaining("亂填二")).toBe(238);
});

it("不是通道那一跳的連線來源，轉送標頭一律不看", async () => {
  expect(await remaining("203.0.113.50", "198.51.100.7")).toBe(239);
  expect(await remaining("203.0.113.51", "198.51.100.7")).toBe(238);
  expect(await remaining("203.0.113.50")).toBe(239);
});

it("一個用戶端把額度用完，不影響其他來源的 Webhook", async () => {
  const flood = { "x-forwarded-for": "203.0.113.1" };
  for (let i = 0; i < 240; i++)
    await app.inject({ url: "/api/public/status", headers: flood });
  expect(
    (await app.inject({ url: "/api/public/status", headers: flood }))
      .statusCode,
  ).toBe(429);
  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/line",
    headers: {
      "x-forwarded-for": "203.0.113.200",
      "content-type": "application/json",
      "x-line-signature": "invalid",
    },
    payload: "{}",
  });
  // 簽章不對照常被拒絕，但不是被流量限制擋下。
  expect(webhook.statusCode).toBe(401);
});
