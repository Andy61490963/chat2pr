import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Line } from "../server/line.js";
import { db, fixture, reset } from "./helpers.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ lineToken: "ExampleLineToken" }),
}));

type Push = { to: string; messages: { type: string; text: string }[] };
function lineApi(send?: (body: Push, key: string) => Promise<Response>) {
  const pushes: Push[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    if (!url.endsWith("/message/push")) throw new Error("未預期的請求");
    const body: Push = JSON.parse(String(init.body));
    pushes.push(body);
    if (send) return send(body, new Headers(init.headers).get("X-Line-Retry-Key")!);
    return Response.json({
      sentMessages: body.messages.map((_, i) => ({ id: `Msg${pushes.length}Item${i + 1}` })),
    });
  });
  return pushes;
}
const notice = (kind: string, text: string, group = "group-a") =>
  db.query("INSERT INTO notifications(kind,dedupe_key,text,group_id) VALUES($1,$2,$2,$3)", [kind, text, group]);
const setUsage = (used: number) =>
  db.query(`INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,$1)
    ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail`, [`本月已用 ${used}／上限 200 則`]);
const usage = () => db.one("SELECT detail FROM service_health WHERE name='line_quota'");
const flush = () => new Line(db).flushNotifications();

beforeEach(async () => {
  await reset();
  await fixture();
  await setUsage(10);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.query("DELETE FROM service_health WHERE name='line_quota'");
});
afterAll(() => db.close());

it("同群首批立即送，兩分鐘內跨輪累積的通知合併付費，逐則保留引用識別碼", async () => {
  const pushes = lineApi();
  await notice("group_ready", "第一份修改已完成");
  await flush();
  await notice("group_merged", "第二份修改已合併");
  await flush();
  await notice("group_answered", "查詢的答案");
  await db.query("INSERT INTO groups(id,name,enabled) VALUES('GroupB','範例群組乙',true)");
  await notice("group_ready", "另一群的修改已完成", "GroupB");
  await flush();
  expect(pushes.map((p) => [p.to, p.messages.map((m) => m.text)])).toEqual([
    ["group-a", ["第一份修改已完成"]], ["GroupB", ["另一群的修改已完成"]],
  ]);
  await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE text='第一份修改已完成'");
  await flush();
  expect(pushes[2].messages.map((m) => m.text)).toEqual(["第二份修改已合併", "查詢的答案"]);
  expect(await db.query("SELECT text,sent_message_id FROM notifications WHERE group_id='group-a' ORDER BY created_at"))
    .toEqual([
      { text: "第一份修改已完成", sent_message_id: "Msg1Item1" },
      { text: "第二份修改已合併", sent_message_id: "Msg3Item1" },
      { text: "查詢的答案", sent_message_id: "Msg3Item2" },
    ]);
  expect(await usage()).toEqual({ detail: "本月已用 22／上限 200 則" });
});

it("剩兩成只推補問、PR、答案及失敗，較早的進度不會擋住重要通知", async () => {
  await setUsage(160);
  const pushes = lineApi();
  for (let i = 1; i <= 12; i++) await notice("group_received", `已收到第 ${i} 項需求`);
  await notice("group_waiting", "等待執行位置");
  await notice("group_resumed", "已自動接續");
  const important = [
    ["group_question", "請選擇日期"],
    ["group_ready", "修改已完成"],
    ["group_merged", "修改已合併"],
    ["group_answered", "查詢已回答"],
    ["group_failed", "請管理者檢查"],
  ];
  for (const [kind, text] of important) await notice(kind, text);
  await flush();
  expect(pushes.map((p) => p.messages.map((m) => m.text))).toEqual([important.map(([, text]) => text)]);
  expect(await usage()).toEqual({ detail: "本月已用 164／上限 200 則" });
  await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE sent_message_id IS NOT NULL");
  await flush();
  expect(pushes).toHaveLength(1);
});

it("推播回應中斷後沿用同批重試鍵，新進度不會混進已收件批次", async () => {
  const keys: string[] = [];
  const pushes = lineApi(async (body, key) => {
    keys.push(key);
    if (keys.length === 1) throw new Error("模擬回應中斷");
    return Response.json({ sentMessages: body.messages.map((_, i) => ({ id: `Accepted${i}` })) }, {
      status: 409, headers: { "x-line-accepted-request-id": "ExampleRequest" },
    });
  });
  await notice("group_answered", "第一題答案");
  await notice("group_merged", "第二題合併");
  await flush();
  await notice("group_received", "第三題收到");
  await flush();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(pushes.map((p) => p.messages.map((m) => m.text))).toEqual([
    ["第一題答案", "第二題合併"], ["第一題答案", "第二題合併"],
  ]);
  expect(await db.query("SELECT sent_message_id FROM notifications WHERE sent_at IS NOT NULL ORDER BY created_at"))
    .toEqual([{ sent_message_id: "Accepted0" }, { sent_message_id: "Accepted1" }]);
});
