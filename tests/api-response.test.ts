import { describe, expect, it } from "vitest";
import { readApiResponse } from "../src/app/api-response.js";

describe("服務中斷的看板回應", () => {
  it("隧道回 HTML 502 時顯示可理解原因，不顯示代理頁面或原始堆疊", async () => {
    await expect(readApiResponse(new Response("<!DOCTYPE html><title>代理內部診斷</title>", {
      status: 502, headers: { "content-type": "text/html" },
    }))).rejects.toThrow("服務暫時無法連線（HTTP 502），請稍後再試。");
  });
  it("成功狀態但內容不是合法 JSON 也不能當成功，服務恢復後可讀取正常資料", async () => {
    await expect(readApiResponse(new Response("<!DOCTYPE html>", { headers: { "content-type": "application/json" } })))
      .rejects.toThrow("服務回應格式異常");
    await expect(readApiResponse(new Response('{"tasks":[]}', { headers: { "content-type": "application/json; charset=utf-8" } })))
      .resolves.toEqual({ tasks: [] });
  });
  it("保留權限與操作錯誤，不因錯誤頁面缺少 JSON 而失去登入判斷", async () => {
    await expect(readApiResponse(new Response("拒絕", { status: 401 }))).rejects.toThrow("登入已失效");
    await expect(readApiResponse(new Response('{"error":"需求版本已改變"}', { status: 409, headers: { "content-type": "application/json" } })))
      .rejects.toThrow("需求版本已改變");
  });
});
