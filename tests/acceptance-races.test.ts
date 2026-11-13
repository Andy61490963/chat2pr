import { afterAll, beforeEach, expect, it } from "vitest";
import { db, reset, fixture, dashboardAction } from "./helpers.js";
import { Tasks } from "../server/tasks.js";
import { Line } from "../server/line.js";
beforeEach(reset);
afterAll(() => db.close());
it("E04.races：20個同版核准只有1個成功，修改與取消競爭不會沿用舊核准", async () => {
  const project = await fixture(),
    tasks = new Tasks(db);
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,dedupe_key) VALUES($1,'group-a','競態測試','修改文案','[\"文字正確\"]','race-approval') RETURNING id",
    [project],
  );
  const approved = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      dashboardAction(task.id, "approve", 1),
    ),
  );
  expect(approved.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(approved.filter((r) => r.status === "rejected")).toHaveLength(19);
  expect(
    await db.one(
      "SELECT status,version,approved_version FROM tasks WHERE id=$1",
      [task.id],
    ),
  ).toEqual({ status: "queued", version: 1, approved_version: 1 });
  const results = await Promise.allSettled([
    tasks.action(task.id, "amend", 1, "1000001", {
      summary: "改成新版內容",
      acceptance: ["新版文字正確"],
    }),
    tasks.action(task.id, "cancel", 1, "1000001"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const latest = await db.one<{
    status: string;
    version: number;
    approved_version: number | null;
  }>("SELECT status,version,approved_version FROM tasks WHERE id=$1", [
    task.id,
  ]);
  if (latest.status === "awaiting_approval")
    expect(latest).toEqual({
      status: "awaiting_approval",
      version: 2,
      approved_version: null,
    });
  else expect(latest.status).toBe("cancelled");
  await expect(
    dashboardAction(task.id, "approve", 1),
  ).rejects.toThrow();
});
it("E04.races：原文撤回與核准同時進行，最終換版且舊核准失效", async () => {
  const project = await fixture(),
    tasks = new Tasks(db),
    line = new Line(db);
  await line.ingest({
    events: [
      {
        webhookEventId: "original-event",
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: "original", type: "text", text: "原始需求" },
      },
    ],
  });
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,source_ids,dedupe_key) VALUES($1,'group-a','競態撤回','原始需求','[\"文字正確\"]',ARRAY['original'],'race-unsend') RETURNING id",
    [project],
  );
  await Promise.allSettled([
    dashboardAction(task.id, "approve", 1),
    line.ingest({
      events: [
        {
          webhookEventId: "withdraw-event",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "original" },
        },
      ],
    }),
  ]);
  expect(
    await db.one(
      "SELECT status,version,approved_version FROM tasks WHERE id=$1",
      [task.id],
    ),
  ).toEqual({
    status: "awaiting_approval",
    version: 2,
    approved_version: null,
  });
  expect(
    await db.one("SELECT revoked,text FROM messages WHERE id='original'"),
  ).toEqual({ revoked: true, text: null });
  await expect(
    dashboardAction(task.id, "approve", 1),
  ).rejects.toThrow("版本");
});
