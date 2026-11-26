import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Line } from "../server/line.js";
import { deliveryState } from "../shared/group-delivery.js";
import { db, fixture, reset } from "./helpers.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ lineToken: "ExampleLineToken" }),
}));

const line = new Line(db);
const received: { path: string; texts: string[] }[] = [];

beforeEach(async () => {
  await reset();
  await fixture();
  await db.query(`INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 165／上限 200 則')
    ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail`);
  received.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    const path = new URL(url).pathname;
    if (!["/v2/bot/message/push", "/v2/bot/message/reply"].includes(path))
      throw new Error("非預期的 LINE 請求");
    const body = JSON.parse(String(init.body)) as { messages: { text: string }[] };
    received.push({ path, texts: body.messages.map((m) => m.text) });
    return Response.json({ sentMessages: body.messages.map((_, i) => ({ id: `Example${received.length}Item${i}` })) });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.query("DELETE FROM service_health WHERE name='line_quota'");
});
afterAll(() => db.close());

async function enqueue(kind: string, text: string, status: string | null) {
  const task = status && await db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,title,summary,acceptance,status,dedupe_key) VALUES('group-a',$1,$1,'[]',$2,$1) RETURNING id",
    [text, status],
  );
  await db.query("INSERT INTO notifications(group_id,task_id,kind,dedupe_key,text) VALUES('group-a',$1,$2,$3,$3)",
    [task && task.id, kind, text]);
}

it("低額度仍推播管理者結案及指令判讀結果", async () => {
  await enqueue("group_closed", "範例需求已決定不處理", "rejected");
  await enqueue("group_triage", "這個指令沒有可處理的需求", null);
  await line.flushNotifications();
  expect(received).toEqual([{ path: "/v2/bot/message/push", texts: ["範例需求已決定不處理", "這個指令沒有可處理的需求"] }]);
});

it.each(["早安", "/進度"])("暫緩付費的排隊說明保留至群組發言「%s」時免費送達", async (text) => {
  await enqueue("group_waiting", "示範工作稍後執行", "queued");
  await line.flushNotifications();
  const row = await db.one<{ sent_at: Date | null; attempts: number; last_error: string }>(
    "SELECT sent_at,attempts,last_error FROM notifications WHERE kind='group_waiting'",
  );
  expect(deliveryState(row!)).toMatchObject({ status: "pending", reason: "priority", note: expect.stringContaining("免費回覆") });
  await db.query("UPDATE service_health SET detail='本月已用 10／上限 200 則' WHERE name='line_quota'");
  await line.flushNotifications();
  expect(received).toHaveLength(0);
  await line.ingest({ events: [{
    webhookEventId: "ExampleEvent", type: "message", replyToken: "ExampleReply",
    source: { type: "group", groupId: "group-a" }, message: { type: "text", id: "ExampleMessage", text },
  }] });
  expect(received).toHaveLength(1);
  expect(received[0].path).toBe("/v2/bot/message/reply");
  expect(received[0].texts).toContain("示範工作稍後執行");
  await line.flushNotifications();
  expect(received).toHaveLength(1);
});

it("保留的排隊通知在任務不再排隊時才標成過期", async () => {
  await enqueue("group_waiting", "將到期的排隊說明", "queued");
  await line.flushNotifications();
  await db.query("UPDATE tasks SET status='running' WHERE title='將到期的排隊說明'");
  await line.flushNotifications();
  expect(received).toHaveLength(0);
  expect(await db.one("SELECT sent_at IS NOT NULL AS done,last_error FROM notifications WHERE kind='group_waiting'"))
    .toEqual({ done: true, last_error: "已過期，未補送" });
});

it("群組停用後，先前已排入的結果仍依原回覆設定推播", async () => {
  await enqueue("group_ready", "範例修改已開 PR", "ready");
  await db.query("UPDATE groups SET enabled=false WHERE id='group-a'");
  await line.flushNotifications();
  expect(received).toEqual([{ path: "/v2/bot/message/push", texts: ["範例修改已開 PR"] }]);
});
