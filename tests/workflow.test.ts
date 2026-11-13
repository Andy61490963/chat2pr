import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { db, reset, fixture, dashboardAction } from "./helpers.js";
import { Line } from "../server/line.js";
import { Tasks } from "../server/tasks.js";
import { Budget } from "../server/budget.js";
beforeEach(reset);
afterAll(() => db.close());
describe("持久化收訊與工作決策", () => {
  it("中斷辨識留下的預留會依租約回收並保守記帳，不永久卡住額度", async () => {
    const budget = new Budget(db);
    const id = await budget.reserve(0.15);
    await db.query(
      "UPDATE reservations SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    await budget.recoverExpired();
    await budget.recoverExpired();
    const row = await db.one<{ released: boolean; spent: string }>(
      "SELECT * FROM reservations WHERE id=$1",
      [id],
    );
    expect(row.released).toBe(true);
    expect(Number(row.spent)).toBe(0.15);
    expect((await db.query("SELECT * FROM usage")).length).toBe(1);
    await expect(budget.reserve(3)).resolves.toBeTruthy();
  });
  it("LINE 重送只保存一次，新群組預設不派工", async () => {
    const l = new Line(db),
      body = {
        events: [
          {
            webhookEventId: "evt-1",
            type: "message",
            source: { type: "group", groupId: "new-group" },
            message: { id: "msg-1", type: "text", text: "修正按鈕顏色" },
          },
        ],
      };
    await l.ingest(body);
    await l.ingest(body);
    expect((await db.query("SELECT id FROM messages")).length).toBe(1);
    expect(
      (await db.one<{ enabled: boolean }>("SELECT enabled FROM groups"))
        .enabled,
    ).toBe(false);
  });
  it("撤回先到時後到的原文不會復活", async () => {
    const l = new Line(db);
    await l.ingest({
      events: [
        {
          webhookEventId: "u1",
          type: "unsend",
          source: { type: "group", groupId: "g" },
          unsend: { messageId: "m" },
        },
      ],
    });
    await l.ingest({
      events: [
        {
          webhookEventId: "m1",
          type: "message",
          source: { type: "group", groupId: "g" },
          message: { id: "m", type: "text", text: "應刪除原文" },
        },
      ],
    });
    expect(await db.one("SELECT text,revoked FROM messages")).toEqual({
      text: null,
      revoked: true,
    });
  });
  it("核准需符合版本且重複核准不重複派工", async () => {
    const project = await fixture();
    const t = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,dedupe_key) VALUES($1,'group-a','測試','修改顏色','[\"顏色正確\"]','d1') RETURNING id",
      [project],
    );
    const tasks = new Tasks(db);
    await expect(dashboardAction(t.id, "approve", 2)).rejects.toThrow(
      "版本",
    );
    await dashboardAction(t.id, "approve", 1);
    await expect(dashboardAction(t.id, "approve", 1)).rejects.toThrow(
      "狀態",
    );
    await tasks.action(t.id, "amend", 1, "1000001", {
      summary: "改成符合設計的綠色",
      acceptance: ["符合設計稿"],
    });
    expect(
      await db.one("SELECT version,approved_version,status FROM tasks"),
    ).toEqual({
      version: 2,
      approved_version: null,
      status: "awaiting_approval",
    });
  });
  it("並行預留額度不能超過每日限制", async () => {
    const budget = new Budget(db);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => budget.reserve(3)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
