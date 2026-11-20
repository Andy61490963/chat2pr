import { afterAll, beforeEach, expect, it } from "vitest";
import { buildApp, EMBEDDABLE_PAGE } from "../server/app.js";
import { db, reset } from "./helpers.js";

// 正式伺服器的安全標頭：e2e 用 Vite 開發伺服器，看不到這些標頭，所以在這裡用真的 app 檢查。
beforeEach(reset);
afterAll(() => db.close());

const csp = (headers: Record<string, unknown>) =>
  String(headers["content-security-policy"] ?? "");

it("只有系統頁的架構動畫允許同源 iframe 嵌入，看板與 API 維持禁止", async () => {
  const app = await buildApp(db);
  try {
    const page = await app.inject({ url: `${EMBEDDABLE_PAGE}?embed=1` });
    expect(csp(page.headers)).toContain("frame-ancestors 'self'");
    expect(csp(page.headers)).not.toContain("frame-ancestors 'none'");
    // 其他指令不放寬：腳本仍只允許同源。
    expect(csp(page.headers)).toContain("script-src 'self'");
    for (const url of [
      "/",
      "/system",
      "/api/state",
      "/docs/rag-flow-demo.html",
    ]) {
      const other = await app.inject({ url });
      expect(csp(other.headers)).toContain("frame-ancestors 'none'");
    }
  } finally {
    await app.close();
  }
});
