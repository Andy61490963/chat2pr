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
