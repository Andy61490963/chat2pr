import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-group-secret",
    lineToken: "fictional-line-token",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import {
  commandAck,
  disabledAck,
  notifyGroup,
} from "../server/group-replies.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Awaited<ReturnType<typeof session>>;
let project: string;
let sent: { url: string; body: any }[];

beforeEach(async () => {
  await reset();
  project = await fixture();
  headers = await session();
  app = await buildApp(db);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

const settings = (extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "PUT",
    url: "/api/groups/group-a",
    headers,
    payload: {
      name: "測試群組",
      project_ids: [project],
      enabled: true,
      trigger_mode: "command",
      ...extra,
    },
  });
async function receive(id: string, text: string) {
  const payload = JSON.stringify({
    events: [
      {
        webhookEventId: `event-${id}`,
        type: "message",
        replyToken: `fictional-reply-${id}`,
        source: {
          type: "group",
          groupId: "group-a",
          userId: "private-member-id",
        },
        message: { id, type: "text", text },
      },
    ],
  });
  const r = await app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-group-secret")
        .update(payload)
        .digest("base64"),
    },
  });
  expect(r.statusCode).toBe(200);
}
const replies = () =>
  sent.filter((s) => s.url.endsWith("/v2/bot/message/reply"));
async function task(title = "調整按鈕顏色") {
  return (await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,dedupe_key) VALUES($1,'group-a',$2,'摘要','[]','awaiting_approval',$3) RETURNING id",
    [project, title, `dedupe-${title}`],
  ))!.id;
}
const groupRows = () =>
  db.query<{ kind: string; text: string; group_id: string }>(
    "SELECT kind,text,group_id FROM notifications WHERE group_id IS NOT NULL ORDER BY created_at",
  );

describe("「/任務」的立即回覆", () => {
  it("預設只回覆結果時，/任務 仍立刻用 reply token 回覆收到；一般聊天不回", async () => {
    expect((await settings()).statusCode).toBe(200);
    await receive("m1", "/任務 調整按鈕顏色");
    await receive("m2", "今天午餐吃什麼");
    expect(replies()).toEqual([
      {
        url: "https://api.line.me/v2/bot/message/reply",
        body: {
          replyToken: "fictional-reply-m1",
          messages: [{ type: "text", text: commandAck }],
        },
      },
    ]);
    // 重送同一個事件不會再回覆一次。
    await receive("m1", "/任務 調整按鈕顏色");
    expect(replies()).toHaveLength(1);
  });

  it("群組沒有啟用時說明需求不會被處理；選擇不回覆時完全不回", async () => {
    await settings({ enabled: false });
    await receive("m1", "/任務 調整按鈕顏色");
    expect(replies()[0].body.messages[0].text).toBe(disabledAck);
    await settings({ enabled: false, reply_mode: "off" });
    await receive("m2", "/任務 調整按鈕顏色");
    expect(replies()).toHaveLength(1);
  });
});

describe("群組結果通知", () => {
  it("依群組設定決定要不要排入群組通知", async () => {
    const id = await task();
    await notifyGroup(db, id, "received", "received:1", "收到", "all");
    await notifyGroup(db, id, "answered", "answered:1", "查詢結果");
    expect((await groupRows()).map((r) => r.kind)).toEqual(["group_answered"]);

    await settings({ reply_mode: "all" });
    await notifyGroup(db, id, "received", "received:2", "收到", "all");
    expect((await groupRows()).map((r) => r.kind)).toEqual([
      "group_answered",
      "group_received",
    ]);

    await settings({ reply_mode: "off" });
    await notifyGroup(db, id, "ready", "ready:1", "完成");
    await db.query("UPDATE groups SET reply_mode='results',left_at=now()");
    await notifyGroup(db, id, "ready", "ready:2", "完成");
    expect(await groupRows()).toHaveLength(2);
  });

  it("群組訊息送到群組、不附看板連結；管理者訊息照舊附連結；沒有配對管理者時群組仍送得出去", async () => {
    const id = await task();
    await notifyGroup(
      db,
      id,
      "answered",
      "answered:1",
      "「調整按鈕顏色」的查詢結果",
    );
    await new Line(db).notify(id, "answered", "answered:admin", "查詢完成");
    await new Line(db).flushNotifications();
    const pushes = sent.filter((s) => s.url.endsWith("/push"));
    expect(pushes).toEqual([
      {
        url: "https://api.line.me/v2/bot/message/push",
        body: {
          to: "group-a",
          messages: [{ type: "text", text: "「調整按鈕顏色」的查詢結果" }],
        },
      },
    ]);
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE group_id IS NULL AND sent_at IS NULL",
      ),
    ).toHaveLength(1);

    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{admin_line_id}','\"fictional-admin-id\"')",
    );
    await new Line(db).flushNotifications();
    const admin = sent.filter((s) => s.url.endsWith("/push"))[1].body;
    expect(admin.to).toBe("fictional-admin-id");
    expect(admin.messages[0].text).toContain(`/tasks?task=${id}`);
  });

  it("管理者取消或不採用需求時告訴群組", async () => {
    const id = await task();
    await db.query("UPDATE tasks SET status='awaiting_approval' WHERE id=$1", [
      id,
    ]);
    const cancel = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/actions`,
      headers,
      payload: { action: "reject", version: 1 },
    });
    expect(cancel.statusCode).toBe(200);
    expect((await groupRows()).map((r) => r.text)).toEqual([
      "「調整按鈕顏色」管理者決定不處理。",
    ]);
  });
});

it("同一任務 30 分鐘內只通知一次失敗；其他任務與其他種類不受影響", async () => {
  const first = await task("任務一");
  const second = await task("任務二");
  const line = new Line(db);
  await line.notify(first, "failed", "failed:run-1", "工作需要處理：A");
  await line.notify(first, "failed", "failed:run-2", "工作需要處理：B");
  await line.notify(first, "ready", "ready:1", "PR 已完成");
  await line.notify(second, "failed", "failed:run-3", "工作需要處理：C");
  const rows = await db.query<{ task_id: string; kind: string; text: string }>(
    "SELECT task_id,kind,text FROM notifications WHERE group_id IS NULL ORDER BY created_at",
  );
  expect(rows.map((r) => r.text)).toEqual([
    "工作需要處理：A",
    "PR 已完成",
    "工作需要處理：C",
  ]);
  await db.query(
    "UPDATE notifications SET created_at=now()-interval '31 minutes' WHERE task_id=$1",
    [first],
  );
  await line.notify(first, "failed", "failed:run-4", "工作需要處理：D");
  expect(
    await db.query("SELECT 1 FROM notifications WHERE text='工作需要處理：D'"),
  ).toHaveLength(1);
});

it("設定頁的總開關關閉時，所有群組都不回覆，排隊中的群組訊息也不再送出", async () => {
  await settings();
  const id = await task();
  await notifyGroup(db, id, "answered", "answered:before", "關閉前排入的結果");
  const off = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers,
    payload: {
      paused: true,
      group_replies: false,
      ai_mode: "api",
      daily_runs: 20,
      codex_model: null,
      triage_effort: "medium",
      coding_effort: "medium",
      daily_budget: 15,
      task_budget: 3,
      task_minutes: 30,
      triage_model: "gpt-5.4-mini",
      coding_model: "gpt-6.1-sol",
    },
  });
  expect(off.statusCode).toBe(200);
  expect((await db.settings()).group_replies).toBe(false);

  await receive("m1", "/任務 調整按鈕顏色");
  expect(replies()).toHaveLength(0);
  await notifyGroup(db, id, "ready", "ready:after", "關閉後的結果");
  expect(await groupRows()).toHaveLength(1);
  await new Line(db).flushNotifications();
  expect(sent.filter((s) => s.url.endsWith("/push"))).toHaveLength(0);
  expect(
    await db.query(
      "SELECT 1 FROM notifications WHERE group_id IS NOT NULL AND sent_at IS NOT NULL AND last_error='群組回覆已關閉，未送出'",
    ),
  ).toHaveLength(1);
});
