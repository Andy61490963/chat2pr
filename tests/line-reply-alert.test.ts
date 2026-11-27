import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { dashboardAlerts } from "../server/dashboard-alerts.js";
import { Line } from "../server/line.js";
import { db, fixture, reset } from "./helpers.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ lineToken: "ExampleLineToken" }),
}));

const line = new Line(db);
const notices = () => dashboardAlerts(db, true).then((rows) => rows.filter((row) => row.kind === "reply_uncertain"));
async function speak(text: string, id: string) {
  await line.ingest({ events: [{ webhookEventId: id, type: "message", replyToken: id,
    source: { type: "group", groupId: "group-a" }, message: { id, type: "text", text } }] });
}

beforeEach(async () => {
  await reset();
  await fixture();
  await db.query("DELETE FROM service_health WHERE name='line_quota'");
  await db.query(`UPDATE settings SET value=value || '{"admin_line_id":"ExampleAdmin","line_private_mode":"action"}' WHERE id=1`);
  await db.query(`INSERT INTO notifications(group_id,kind,dedupe_key,text) VALUES
    ('group-a','group_triage','exampleResult','示範指令的處理結果'),
    ('group-a','group_check','exampleOk','示範檢查正常')`);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.close());

it.each([0, 100])("保留群組額度百分之 %i 時，重要回覆未確認會提醒管理者一次，取回後解除提醒", async (reserve) => {
  await db.query("UPDATE settings SET value=jsonb_set(value,'{line_group_reserve_percent}',to_jsonb($1::int))", [reserve]);
  await db.query("INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 1／上限 200 則')");
  const privateMessages: string[] = [];
  let uncertain = true;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/message/reply") && uncertain) return new Response(null, { status: 503 });
    if (url.endsWith("/message/push") && body.to === "ExampleAdmin") privateMessages.push(body.messages[0].text);
    return Response.json({ sentMessages: body.messages.map(() => ({ id: "ExampleMessage" })) });
  });
  await speak("大家好", "ExampleHello");
  await line.flushNotifications();
  await speak("/進度", "ExampleUnconfirmed");
  await line.flushNotifications();
  const alerts = await notices();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ disposition: "action", text: expect.stringContaining("轉達") });
  expect(JSON.stringify(alerts)).not.toContain("示範檢查正常");
  expect(privateMessages).toHaveLength(reserve === 0 ? 1 : 0);
  if (reserve === 0) expect(privateMessages[0]).toContain("轉達");
  uncertain = false;
  await speak("/進度", "ExampleRecovered");
  expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
  await db.query("UPDATE settings SET value=jsonb_set(value,'{line_group_reserve_percent}','0')");
  await line.flushNotifications();
  expect(privateMessages).toHaveLength(reserve === 0 ? 1 : 0);
});

function replyServer(status: number, replies: string[][] = []) {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const messages = JSON.parse(String(init.body)).messages as { text: string }[];
    replies.push(messages.map((m) => m.text));
    return status === 200 ? Response.json({ sentMessages: messages.map(() => ({ id: "ExampleReply" })) })
      : Response.json({ message: status === 400 ? "Invalid reply token" : "" }, { status });
  });
}

async function addQueryAnswer() {
  await db.query(`WITH task AS (
      INSERT INTO tasks(group_id,title,summary,status,mode,dedupe_key)
      VALUES('group-a','範例運費查詢','示範摘要','answered','query','exampleQuery') RETURNING id)
    INSERT INTO notifications(group_id,task_id,kind,dedupe_key,text)
    SELECT 'group-a',id,'group_answered','exampleAnswer','範例運費為三十元' FROM task`);
}

it.each([
  { age: "25 小時", interval: "25 hours", retrievable: true },
  { age: "8 天", interval: "8 days", retrievable: false },
])("查詢回答未確認送達 $age 後，鈴鐺與 /進度 遵守七天取回期限", async ({ interval, retrievable }) => {
  await db.query("DELETE FROM notifications");
  await addQueryAnswer();
  replyServer(503);
  await speak("早安", "ExampleFirst");
  expect(await notices()).toMatchObject([{ disposition: "action" }]);
  await db.query("UPDATE notifications SET created_at=now()-$1::interval WHERE kind='group_answered'", [interval]);
  expect.soft(await notices()).toMatchObject([{ disposition: retrievable ? "action" : "resolved" }]);
  const replies: string[][] = [];
  replyServer(200, replies);
  await speak("/進度", "ExampleProgress");
  expect(replies.flat().join("\n")).toContain(retrievable ? "範例運費為三十元" : "目前沒有待取回的結果");
  expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
});

it.each(["判讀過時", "補問已作答", "補問超過七天", "失敗任務已恢復"])("%s時取回、群組提示與管理者鈴鐺一同解除", async (scenario) => {
  if (scenario !== "判讀過時") {
    await db.query("DELETE FROM notifications");
    const failed = scenario === "失敗任務已恢復";
    await db.query(`WITH task AS (INSERT INTO tasks(group_id,title,summary,status,dedupe_key,question)
      VALUES('group-a','範例匯出','範例摘要',$1,'exampleTask','{"text":"是否匯出？"}') RETURNING id,version)
      INSERT INTO notifications(group_id,task_id,kind,dedupe_key,text)
      SELECT 'group-a',id,$2,'group:question:'||id||':'||version,'範例待取回內容' FROM task`,
      [failed ? "failed" : "awaiting_approval", failed ? "group_failed" : "group_question"]);
  }
  replyServer(503);
  await speak("早安", "ExampleFirst");
  expect(await notices()).toMatchObject([{ disposition: "action" }]);
  if (scenario === "判讀過時") await db.query("UPDATE notifications SET created_at=now()-interval '25 hours' WHERE group_id='group-a'");
  else if (scenario === "補問超過七天") await db.query("UPDATE notifications SET created_at=now()-interval '8 days' WHERE group_id='group-a'");
  else await db.query("UPDATE tasks SET status='answered',question=NULL WHERE group_id='group-a'");
  expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
  const replies: string[][] = [];
  replyServer(200, replies);
  await speak("/進度", "ExampleProgress");
  expect(replies.flat().join("\n")).not.toMatch(/範例待取回內容|示範指令的處理結果|不確定是否送達/);
});

it.each([400, 429])("免費補送明確遭拒（%i）後下次發言仍可補送", async (status) => {
  replyServer(503);
  await speak("早安", "ExampleFirst");
  await db.query("UPDATE notifications SET line_reply_uncertain_at=now()-interval '6 minutes' WHERE line_reply_policy='manual'");
  replyServer(status);
  await speak("午安", "ExampleRejected");
  const replies: string[][] = [];
  replyServer(200, replies);
  await speak("晚安", "ExampleRetry");
  expect(replies.flat()).toEqual([expect.stringContaining("（補送：先前可能沒送到，看過可略過）")]);
});

it("同批重要回覆只提醒一次，摘要使用任務標題或通知種類，全部失效才解除", async () => {
  await addQueryAnswer();
  replyServer(503);
  await speak("早安", "ExampleBatch");
  const alerts = await notices();
  expect(alerts).toHaveLength(1);
  expect(alerts[0].text).toContain("2 則");
  expect(alerts[0].text).toContain("指令判讀");
  expect(alerts[0].text).toContain("範例運費查詢");
  expect(alerts[0].text).not.toMatch(/示範指令的處理結果|範例運費為三十元/);
  await db.query("UPDATE notifications SET created_at=now()-interval '2 days' WHERE dedupe_key='exampleResult'");
  expect(await notices()).toMatchObject([{ disposition: "action" }]);
  await speak("/進度", "ExampleAgain");
  expect(await notices()).toHaveLength(1);
  replyServer(200);
  await speak("/進度", "ExampleSuccess");
  expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
});
