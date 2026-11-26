import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Line } from "../server/line.js";
import { repliesOffNote } from "../shared/group-delivery.js";
import { claimPendingGroupReplies } from "../server/group-replies.js";
import { syncLineQuota } from "../server/line-quota.js";
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
const noticeStatus: Record<string, string> = {
  group_received: "awaiting_approval", group_question: "awaiting_approval", group_ready: "ready",
  group_answered: "answered", group_merged: "merged", group_failed: "failed", group_waiting: "queued", group_resumed: "queued",
};
async function notice(kind: string, text: string, group = "group-a") {
  const task = (await db.one<{ id: string }>(
    `INSERT INTO tasks(group_id,title,summary,acceptance,status,question,dedupe_key)
     VALUES($1,$2,'範例摘要','[]',$3,$4::jsonb,$2) RETURNING id`,
    [group, text, noticeStatus[kind], kind === "group_question" ? JSON.stringify({ text, choices: [] }) : null],
  ))!;
  return db.query("INSERT INTO notifications(kind,dedupe_key,text,group_id,task_id) VALUES($1,$2,$3,$4,$5)",
    [kind, `group:${kind.slice(6)}:${task.id}:1`, text, group, task.id]);
}
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

it("帶常見答案的補問放在批次末尾，下一題仍有自己的按鈕", async () => {
  const pushes = lineApi();
  await notice("group_merged", "第一份修改已合併");
  await notice("group_question", "請選擇表單");
  await notice("group_question", "請選擇日期");
  await db.query(`UPDATE notifications SET quick_replies=$1::jsonb WHERE kind='group_question'`, [
    JSON.stringify([{ label: "第一項", displayText: "選第一項", data: "ExampleAnswer" }]),
  ]);
  await flush();
  expect(pushes).toHaveLength(1);
  expect(pushes[0].messages.map((m) => m.text)).toEqual(["第一份修改已合併", "請選擇表單"]);
  expect(pushes[0].messages.at(-1)).toMatchObject({
    quickReply: { items: [{ action: { type: "postback", data: "ExampleAnswer" } }] },
  });
  await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE sent_message_id IS NOT NULL");
  await flush();
  expect(pushes[1].messages).toEqual([expect.objectContaining({ text: "請選擇日期", quickReply: expect.anything() })]);
});

it("群組關閉回覆或離開後才輪到的待送通知不推播", async () => {
  const pushes = lineApi();
  await db.query("INSERT INTO groups(id,name,enabled) VALUES('GroupB','範例群組乙',true)");
  await notice("group_ready", "原定通知甲");
  await notice("group_answered", "原定通知乙", "GroupB");
  await db.query("UPDATE groups SET reply_mode='off' WHERE id='group-a'");
  await db.query("UPDATE groups SET left_at=now() WHERE id='GroupB'");
  await flush();
  expect(pushes).toHaveLength(0);
  expect(await db.query("SELECT last_error FROM notifications WHERE group_id IS NOT NULL")).toEqual([
    { last_error: repliesOffNote }, { last_error: repliesOffNote },
  ]);
  await db.query("UPDATE groups SET reply_mode='results',left_at=NULL");
  await flush();
  expect(pushes).toHaveLength(0);
});

it("未確認收件的舊批次跨日後略過過期通知，保留仍有效的結果", async () => {
  const uncertain = lineApi(async () => { throw new Error("模擬網路中斷"); });
  await notice("group_answered", "過期的查詢答案");
  await notice("group_ready", "仍有效的修改結果");
  await flush();
  expect(uncertain).toHaveLength(1);
  await db.query("UPDATE notifications SET created_at=now()-interval '2 days' WHERE text='過期的查詢答案'");
  const pushes = lineApi();
  await flush();
  expect(pushes.flatMap((p) => p.messages.map((m) => m.text))).toEqual(["仍有效的修改結果"]);
  expect(await db.one("SELECT last_error FROM notifications WHERE text='過期的查詢答案'")).toEqual({ last_error: "已過期，未補送" });
});

it("已有重試批次時降至兩成，只以新鍵推仍需送達的重要通知", async () => {
  const keys: string[] = [];
  const pushes = lineApi(async (body, key) => {
    keys.push(key);
    if (keys.length === 1) throw new Error("模擬回應中斷");
    return Response.json({ sentMessages: body.messages.map((_, i) => ({ id: `Retry${i}` })) });
  });
  await notice("group_received", "這項已收到");
  await notice("group_answered", "查詢的答覆");
  await flush();
  await setUsage(160);
  await flush();
  expect(pushes.map((p) => p.messages.map((m) => m.text))).toEqual([["這項已收到", "查詢的答覆"], ["查詢的答覆"]]);
  expect(keys[0]).not.toBe(keys[1]);
});

it("每輪最多查五十個群組的人數，下一輪會輪到額度夠用的小群組", async () => {
  await setUsage(197);
  const checked: string[] = [];
  const recipients: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/members/count")) {
      checked.push(url);
      return Response.json({ count: url.includes("/Group51/") ? 2 : 4 });
    }
    recipients.push(JSON.parse(String(init.body)).to);
    return Response.json({ sentMessages: [{ id: "Delivered" }] });
  });
  await db.query(`INSERT INTO groups(id,name,enabled)
     SELECT 'Group'||i,'範例群組'||i,true FROM generate_series(1,51) i`);
  await db.query(`INSERT INTO notifications(kind,dedupe_key,text,group_id,created_at)
     SELECT 'group_answered','answer'||i,'範例回答','Group'||i,now()-interval '1 minute'+i*interval '1 second'
     FROM generate_series(1,51) i`);
  await flush();
  expect(checked).toHaveLength(50);
  await flush();
  expect(checked).toHaveLength(51);
  expect(recipients).toEqual(["Group51"]);
});

it("無法確認推播結果又發現額度不足時，把已領取的答案還給免費回覆", async () => {
  await notice("group_answered", "範例答案");
  lineApi(async () => { throw new Error("模擬回應中斷"); });
  await flush();
  const collect = () => db.transaction((c) => claimPendingGroupReplies(c, "group-a", 5, "line", null, "important"));
  expect((await collect()).replies).toHaveLength(0);
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(url.endsWith("/quota") ? { type: "limited", value: 200 } : { totalUsage: 200 }));
  await syncLineQuota(db, "SampleToken");
  expect((await collect()).replies.map((n) => n.text)).toEqual(["範例答案"]);
});

it("通知原有的失敗次數不同時，每個重試鍵始終對應同一份名單", async () => {
  const attempts = new Map<string, string[]>();
  const changed: string[] = [];
  const pushes = lineApi(async (body, key) => {
    const texts = body.messages.map((m) => m.text);
    if (attempts.has(key) && JSON.stringify(attempts.get(key)) !== JSON.stringify(texts)) changed.push(key);
    attempts.set(key, texts);
    throw new Error("模擬回應中斷");
  });
  await notice("group_merged", "已嘗試兩次的合併通知");
  await db.query("UPDATE notifications SET attempts=2");
  await notice("group_ready", "剛完成的修改");
  await flush();
  await flush();
  expect(pushes).toHaveLength(2);
  expect(changed).toEqual([]);
});

it("兩分鐘內已回答的補問不再推播舊問題與按鈕", async () => {
  const pushes = lineApi();
  await notice("group_ready", "第一件完成的修改");
  await flush();
  const { id } = (await db.one<{ id: string }>(`INSERT INTO tasks(group_id,title,summary,acceptance,status,question,dedupe_key)
    VALUES('group-a','範例問題','摘要','[]','awaiting_approval','{"text":"哪個表單？","choices":["第一項"]}','ExampleQuestion') RETURNING id`))!;
  await db.query(`INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,quick_replies)
    VALUES($1::uuid,'group_question','group:question:'||$1::uuid||':1','哪個表單？','group-a',$2::jsonb)`,
    [id, JSON.stringify([{ label: "第一項", data: "ExampleAnswer", displayText: "第一項" }])]);
  await flush();
  await db.query("UPDATE tasks SET question=NULL,status='queued' WHERE id=$1", [id]);
  await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE kind='group_ready'");
  await flush();
  expect(pushes).toHaveLength(1);
  expect(await db.one("SELECT last_error FROM notifications WHERE task_id=$1", [id])).toEqual({ last_error: "已過期，未補送" });
});

it("LINE 拒收含錯誤內容的整批時，分開送出正常答案，只讓壞訊息累計三次失敗", async () => {
  const pushes = lineApi(async (body) => body.messages.some((m) => m.text === "錯誤內容")
    ? Response.json({ message: "Invalid message" }, { status: 400 })
    : Response.json({ sentMessages: body.messages.map((_, i) => ({ id: `Valid${i}` })) }));
  const expected = ["第一題答案", "錯誤內容", "第三題答案", "第四題答案", "第五題答案"];
  for (const text of expected) await notice("group_answered", text);
  for (let i = 0; i < 10; i++) {
    await flush();
    await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE sent_message_id IS NOT NULL");
  }
  expect(pushes[0].messages.map((m) => m.text)).toEqual(expected);
  expect(await db.query("SELECT text FROM notifications WHERE sent_message_id IS NOT NULL ORDER BY created_at"))
    .toEqual(expected.filter((text) => text !== "錯誤內容").map((text) => ({ text })));
  expect(await db.one("SELECT sent_at,attempts FROM notifications WHERE text='錯誤內容'")).toEqual({ sent_at: null, attempts: 3 });
  expect(pushes.filter((p) => p.messages.length === 1 && p.messages[0].text === "錯誤內容")).toHaveLength(3);
});
