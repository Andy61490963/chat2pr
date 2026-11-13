import { afterAll, beforeEach, expect, it } from "vitest";
import { db, reset, fixture } from "./helpers.js";
import { syncOpenPullRequests } from "../server/pr-sync.js";
import {
  clip,
  failureSummary,
  prReport,
  testHighlights,
} from "../server/pr-body.js";

beforeEach(reset);
afterAll(() => db.close());

it("Webhook 延遲時定期同步 PR 狀態：關閉、合併、仍開啟分別處理", async () => {
  const project = await fixture();
  for (const [n, key] of [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ] as const)
    await db.query(
      "INSERT INTO tasks(project_id,group_id,title,summary,status,pr_number,dedupe_key) VALUES($1,'group-a','任務','內容','ready',$2,$3)",
      [project, n, key],
    );
  const states: Record<number, { state: "open" | "closed"; merged: boolean }> =
    {
      1: { state: "closed", merged: false },
      2: { state: "closed", merged: true },
      3: { state: "open", merged: false },
    };
  await syncOpenPullRequests(db, { pullState: async (_p, n) => states[n] });
  const rows = await db.query<{ pr_number: number; status: string }>(
    "SELECT pr_number,status FROM tasks ORDER BY pr_number",
  );
  expect(rows.map((r) => r.status)).toEqual(["closed", "merged", "ready"]);
  expect(
    (await db.query("SELECT 1 FROM audit WHERE detail LIKE '%定期同步%'"))
      .length,
  ).toBe(2);
});

it("PR 說明略過編譯警告，只留一行測試結果與節錄", () => {
  const output = [
    ...Array.from(
      { length: 50 },
      (_, i) => `Foo.cs(${i},1): warning CS8618: Non-nullable property`,
    ),
    "Passed!  - Failed:     0, Passed:   390, Skipped:     0, Total:   390",
  ].join("\n");
  expect(testHighlights(output).headline).toEqual([
    "Passed!  - Failed:     0, Passed:   390, Skipped:     0, Total:   390",
  ]);
  const body = prReport({
    codexSummary: "- 新增說明文件",
    testCommand: "dotnet test",
    testOutput: output,
  });
  expect(body).toContain("## 這次做了什麼");
  expect(body).toContain("Passed:   390");
  expect(body).not.toContain("warning CS8618");
  expect(body).toContain("<details>");
});
it("失敗原因截短時停在句尾並標示還有內容；動態只放審查意見或測試重點", () => {
  const long =
    "第一句說明問題。".repeat(30) + "最後一句很長沒有句號".repeat(10);
  const short = clip(long, 100, "…（完整內容見執行紀錄）");
  expect(short.endsWith("。…（完整內容見執行紀錄）")).toBe(true);
  expect(clip("短句", 100)).toBe("短句");
  expect(
    failureSummary(["缺少整合測試"], "OrderService -> /workspace/x.dll"),
  ).toBe("缺少整合測試");
  const fromTest = failureSummary(
    [],
    "warning CS8618: 很吵\nOrderService -> /workspace/x.dll\nFailed!  - Failed: 2, Passed: 388, Total: 390",
  );
  expect(fromTest).toContain("Failed: 2");
  expect(fromTest).not.toContain("warning");
});
it("舊時間軸紀錄改寫：去掉上下文 JSON，操作寫明帳號與動作", async () => {
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,csrf,expires_at,login) VALUES('h-old','424242','c',now()+interval '1 hour','octo-fake')",
  );
  await db.query(
    "INSERT INTO audit(task_id,kind,detail) VALUES(NULL,'approve','管理者 424242 操作需求版本 2'),(NULL,'retrieval','判讀參考：檢索到 1 則舊對話；上下文範圍 {\"recentConversation\":{\"limit\":300}}')",
  );
  await db.migrate();
  const rows = (
    await db.query<{ kind: string; detail: string }>(
      "SELECT kind,detail FROM audit ORDER BY kind",
    )
  ).map((r) => r.detail);
  expect(rows).toEqual([
    "octo-fake 核准（需求版本 2）",
    "判讀參考：檢索到 1 則舊對話",
  ]);
});
