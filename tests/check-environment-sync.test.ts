import { expect, it, vi } from "vitest";
import { syncCheckEnvironments, type RunnerCall } from "../server/checks.js";
import type { Database } from "../server/db.js";

// 保留正式的同步與稽核流程，只替換資料庫連線和執行器傳輸。
function scenario(reply: unknown) {
  const db = {
    query: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({}),
    one: vi.fn().mockResolvedValue({ name: "測試站台" }),
    audit: vi.fn(),
  };
  const call: RunnerCall = async <T>() => reply as T;
  return {
    db,
    sync: () => syncCheckEnvironments(db as unknown as Database, call),
  };
}

it("執行器回報沒有清除項目時，同步成功且不寫稽核", async () => {
  const { db, sync } = scenario({ removed: [] });
  await expect(sync()).resolves.toEqual([]);
  expect(db.audit).not.toHaveBeenCalled();
});

it.each([
  { exitCode: 0, stdout: "", stderr: "" },
  { removed: false },
  { removed: [{ checkId: "非法識別碼", reason: "idle" }] },
])(
  "同步收到其他工作回應或異常項目時，回報明確錯誤並保留稽核完整性",
  async (reply) => {
    const { db, sync } = scenario(reply);
    await expect(sync()).rejects.toMatchObject({
      statusCode: 502,
      message: "執行器回傳的檢查環境清除清單格式不正確",
    });
    expect(db.audit).not.toHaveBeenCalled();
  },
);
