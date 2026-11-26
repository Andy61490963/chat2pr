import { randomUUID } from "node:crypto";
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
import { readFile } from "node:fs/promises";
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
import { discordId } from "../server/chat-platform.js";
import {
  aiQuotaAck,
  answerAck,
  autoResumeText,
  answerHeldAck,
  claimPendingGroupReplies,
  claimingNote,
  commandAck,
  detailHint,
  disabledAck,
  lineChunks,
  noProjectAck,
  notifyGroup,
  pausedAck,
  replyFailedNote,
  replyGaveUpNote,
  tellGroupWaiting,
} from "../server/group-replies.js";
import { askInGroup } from "../server/answers.js";
import { approvalNotice } from "../server/project-routing.js";
import { dueTriageGroups } from "../server/triage-window.js";
import { GitHub } from "../server/github.js";
import { deliveryLabel, deliveryNotice } from "../shared/group-delivery.js";
import { expiredNote, quotaExhaustedDetail } from "../shared/line-quota.js";
import {
  expireStaleNotifications,
  syncLineQuota,
} from "../server/line-quota.js";
import { recordHealth } from "../server/health.js";
import type { Task } from "../shared/types.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let line: Line;
let headers: Awaited<ReturnType<typeof session>>;
let project: string;
let sent: { url: string; body: any }[];

beforeEach(async () => {
  await reset();
  project = await fixture();
  headers = await session();
  line = new Line(db);
  app = await buildApp(db, undefined, undefined, undefined, undefined, undefined, undefined, line);
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
async function receive(id: string, text: string, groupId = "group-a") {
  const payload = JSON.stringify({
    events: [
      {
        webhookEventId: `event-${id}`,
        type: "message",
        replyToken: `fictional-reply-${id}`,
        source: {
          type: "group",
          groupId,
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

const exampleDiscordGroup = discordId("100000000000000001");

async function addDiscordGroup() {
  await db.query(
    "INSERT INTO groups(id,name,platform,enabled) VALUES($1,'範例頻道','discord',true)",
    [exampleDiscordGroup],
  );
}

it("遷移將既有群組標為 LINE，重跑保留 Discord，兩種平台都出現在看板 API", async () => {
  const schema = await readFile(new URL("../server/schema.sql", import.meta.url), "utf8");
  await db.transaction(async (c) => {
    await c.query("ALTER TABLE groups DROP COLUMN platform");
    await c.query(schema);
    await c.query(
      "INSERT INTO groups(id,name,platform) VALUES($1,'範例頻道','discord')",
      [exampleDiscordGroup],
    );
    await c.query(schema);
  });
  await expect(db.query(
    "INSERT INTO groups(id,name,platform) VALUES('group-invalid','範例群組','未知平台')",
  )).rejects.toMatchObject({ code: "23514" });
  const state = await app.inject({ url: "/api/state", headers });
  expect(state.statusCode).toBe(200);
  expect(state.json().groups).toEqual([
    expect.objectContaining({ id: "group-a", platform: "line" }),
    expect.objectContaining({ id: exampleDiscordGroup, platform: "discord" }),
  ]);
});

describe("群組通知依聊天平台分流", () => {
  afterEach(() => db.query("DELETE FROM service_health WHERE name='line_quota'"));

  it("較早的 Discord 通知不佔 LINE 推播批次，也不查 LINE 人數或扣額度", async () => {
    await addDiscordGroup();
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,group_id,created_at)
       SELECT 'group_answered','discord:'||i,'範例頻道的回覆',$1,now()-interval '1 hour'
       FROM generate_series(1,11) i`,
      [exampleDiscordGroup],
    );
    await notifyGroup(db, await task(), "answered", "line:result", "測試群組的回覆");
    await db.query(
      `INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 10／上限 200 則')
       ON CONFLICT(name) DO UPDATE SET ok=EXCLUDED.ok,detail=EXCLUDED.detail`,
    );
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/members/count")
        ? Response.json({ count: 3 })
        : Response.json({ sentMessages: [{ id: "fictional-push" }] }),
    );
    vi.stubGlobal("fetch", fetch);

    await new Line(db).flushNotifications();

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.line.me/v2/bot/group/group-a/members/count",
      "https://api.line.me/v2/bot/message/push",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).to).toBe("group-a");
    expect(await db.one("SELECT detail FROM service_health WHERE name='line_quota'"))
      .toEqual({ detail: "本月已用 13／上限 200 則" });
    await db.query("UPDATE settings SET value=value||'{\"group_replies\":false}'::jsonb WHERE id=1");
    await new Line(db).flushNotifications();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await db.query(
      `SELECT id FROM notifications WHERE group_id=$1
       AND (attempts<>0 OR sent_at IS NOT NULL OR last_error IS NOT NULL)`,
      [exampleDiscordGroup],
    )).toEqual([]);
  });

  it("LINE 的過期處理與手動重送不變更 Discord 通知，聊天室顯示送達失敗", async () => {
    await addDiscordGroup();
    const quotaNote = "推播額度剩 1 則，不足這個群組的人數，額度恢復後再送";
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,group_id,created_at,attempts,last_error)
       VALUES('group_answered','discord:old','範例頻道的舊回覆',$1,now()-interval '2 days',3,$2)`,
      [exampleDiscordGroup, quotaNote],
    );
    await db.query(
      `INSERT INTO service_health(name,ok,detail) VALUES('line_quota',false,$1)
       ON CONFLICT(name) DO UPDATE SET ok=EXCLUDED.ok,detail=EXCLUDED.detail`,
      [quotaExhaustedDetail],
    );
    const chat = await app.inject({
      url: `/api/groups/${encodeURIComponent(exampleDiscordGroup)}/messages`,
      headers,
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().bot_messages[0].delivery).toMatchObject({
      status: "failed",
      reason: "error",
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/consumption")
      ? Response.json({ totalUsage: 0 })
      : Response.json({ type: "limited", value: 200 }),
    ));
    await syncLineQuota(db, "虛構權杖");
    await new Line(db).flushNotifications();
    const retry = await app.inject({ method: "POST", url: "/api/notifications/retry", headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().group).toBe(0);
    expect(await db.one(
      "SELECT sent_at,attempts,last_error FROM notifications WHERE dedupe_key='discord:old'",
    )).toEqual({ sent_at: null, attempts: 3, last_error: quotaNote });
  });

  it("LINE 的 /進度 不會回覆 Discord 頻道或領取其待送通知", async () => {
    await addDiscordGroup();
    const id = await db.one<{ id: string }>(
      "INSERT INTO tasks(group_id,title,summary,dedupe_key) VALUES($1,'範例需求','顯示進度','discord:task') RETURNING id",
      [exampleDiscordGroup],
    );
    await notifyGroup(db, id.id, "answered", "discord:result", "範例頻道的回覆");
    await receive("fictional-discord-progress", "/進度", exampleDiscordGroup);
    expect(replies()).toEqual([]);
    expect(await db.one(
      "SELECT sent_at,attempts,last_error FROM notifications WHERE group_id=$1",
      [exampleDiscordGroup],
    )).toEqual({ sent_at: null, attempts: 0, last_error: null });
  });
});

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
      `UPDATE settings SET value=value||'{"admin_line_id":"fictional-admin-id","line_private_mode":"all","line_group_reserve_percent":0}'::jsonb`,
    );
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '11 minutes' WHERE dedupe_key='answered:admin'",
    );
    await new Line(db).flushNotifications();
    const admin = sent.filter((s) => s.url.endsWith("/push"))[1].body;
    expect(admin.to).toBe("fictional-admin-id");
    expect(admin.messages).toEqual([
      { type: "text", text: expect.stringContaining("查詢完成") },
    ]);
    expect(admin.messages[0].text).toContain("看板：http://localhost:4310");
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

describe("LINE 每月推播額度用完", () => {
  // line_quota 不在 reset() 清除的資料表裡；留著會讓其他測試的推播全部暫停。
  const clearQuota = () =>
    db.query(
      "DELETE FROM service_health WHERE name IN ('line_quota','notifications')",
    );
  beforeEach(clearQuota);
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearQuota();
  });

  /** 模擬 LINE：推播依 push 回應，額度 API 依 quota 回應；其他外部服務一律回空物件。 */
  const lineApi = (opts: {
    push: () => Response;
    quota?: { limit: number | null; used: number };
  }) => {
    const pushes: { to: string; texts: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v2/bot/message/push")) {
          const body = JSON.parse(String(init?.body));
          pushes.push({ to: body.to, texts: body.messages.map((m: { text: string }) => m.text) });
          return opts.push();
        }
        if (url.endsWith("/v2/bot/message/quota") && opts.quota)
          return Response.json(
            opts.quota.limit === null
              ? { type: "none" }
              : { type: "limited", value: opts.quota.limit },
          );
        if (url.endsWith("/v2/bot/message/quota/consumption") && opts.quota)
          return Response.json({ totalUsage: opts.quota.used });
        return Response.json({});
      }),
    );
    return pushes;
  };
  const monthlyLimit = () =>
    Response.json(
      { message: "You have reached your monthly limit." },
      { status: 429 },
    );
  const quota = () =>
    db.one<{ ok: boolean; detail: string }>(
      "SELECT ok,detail FROM service_health WHERE name='line_quota'",
    );
  const rows = () =>
    db.query<{
      text: string;
      attempts: number;
      sent_at: Date | null;
      last_error: string | null;
    }>(
      "SELECT text,attempts,sent_at,last_error FROM notifications WHERE group_id IS NOT NULL ORDER BY created_at",
    );
  const check = () =>
    app.inject({ method: "POST", url: "/api/integrations/check", headers });

  it("推播回每月上限：不算失敗次數、本輪只推一次、記下額度用完；封鎖期間不再推播", async () => {
    const id = await task();
    for (const n of [1, 2, 3])
      await notifyGroup(db, id, "answered", `answered:${n}`, `結果 ${n}`);
    const pushes = lineApi({ push: monthlyLimit });
    const line = new Line(db);
    await line.flushNotifications();
    expect(pushes).toHaveLength(1);
    const after = await rows();
    expect(after.map((r) => r.attempts)).toEqual([0, 0, 0]);
    expect(after.every((r) => r.sent_at === null)).toBe(true);
    expect(after[0].last_error).toContain("LINE 本月推播額度已用完");
    expect(await quota()).toEqual({
      ok: false,
      detail:
        "LINE 本月推播額度已用完，下個月初重置；群組的『收到』與看板鈴鐺不受影響",
    });
    // 額度用完不是連線問題，「LINE 推播」健康項不能被寫成失敗。
    expect(
      await db.query(
        "SELECT 1 FROM service_health WHERE name='notifications' AND NOT ok",
      ),
    ).toHaveLength(0);
    // 也不在重要服務清單：不會再排一則送不出去的「服務異常」私訊。
    expect(
      await db.query("SELECT 1 FROM notifications WHERE kind='service_down'"),
    ).toHaveLength(0);

    for (let n = 0; n < 3; n++) await line.flushNotifications();
    expect(pushes).toHaveLength(1);
    expect((await rows()).map((r) => r.attempts)).toEqual([0, 0, 0]);
  });

  it("一般 429（不是每月上限）照舊累加失敗次數、之後再試", async () => {
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:busy", "結果");
    const pushes = lineApi({
      push: () =>
        Response.json({ message: "Too many requests" }, { status: 429 }),
    });
    const line = new Line(db);
    await line.flushNotifications();
    await line.flushNotifications();
    expect(pushes).toHaveLength(2);
    const [row] = await rows();
    expect(row.attempts).toBe(2);
    expect(row.last_error).toContain("LINE 推播太頻繁，稍後會再送（429）");
    expect(await quota()).toBeUndefined();
  });

  it("查到有剩餘額度就解除暫停：過時的群組訊息標成已過期不送，仍有效的照常送出", async () => {
    vi.spyOn(GitHub.prototype, "repos").mockResolvedValue([]);
    const answered = await task("查詢結果");
    const waiting = await task("排隊中的修改");
    const oldQuestion = await task("舊版補問");
    const question = await task("目前補問");
    await db.query("UPDATE tasks SET status='queued' WHERE id=$1", [waiting]);
    await db.query(
      `UPDATE tasks SET question='{"text":"要改哪個頁面？","choices":[]}' WHERE id IN ($1,$2)`,
      [oldQuestion, question],
    );
    await db.query("UPDATE tasks SET version=2 WHERE id=$1", [oldQuestion]);
    await notifyGroup(db, answered, "answered", "answered:old", "兩天前的結果");
    await tellGroupWaiting(db, waiting, "daily");
    await notifyGroup(
      db,
      oldQuestion,
      "question",
      `question:${oldQuestion}:1`,
      "舊版的問題",
    );
    await notifyGroup(
      db,
      question,
      "question",
      `question:${question}:1`,
      "目前的問題",
    );
    await notifyGroup(db, answered, "answered", "answered:new", "剛完成的結果");
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '2 days' WHERE dedupe_key='group:answered:old'",
    );
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '7 hours' WHERE kind='group_waiting'",
    );

    // 額度用完、推播暫停。
    let pushes = lineApi({ push: monthlyLimit });
    await new Line(db).flushNotifications();
    expect(pushes).toHaveLength(1);

    // 額度 API 還是滿的：維持暫停，用量寫進說明。
    lineApi({ push: monthlyLimit, quota: { limit: 200, used: 200 } });
    expect((await check()).statusCode).toBe(200);
    expect((await quota())?.ok).toBe(false);
    expect((await quota())?.detail).toContain("本月已用 200／上限 200 則");

    // 新月份有額度了：解除暫停，先清掉過時的訊息再續送。
    pushes = lineApi({
      push: () => Response.json({ sentMessages: [{ id: "fictional-msg" }] }),
      quota: { limit: 200, used: 3 },
    });
    expect((await check()).statusCode).toBe(200);
    expect(await quota()).toEqual({
      ok: true,
      detail: "本月已用 3／上限 200 則",
    });
    await new Line(db).flushNotifications();
    expect(pushes.map((p) => p.texts)).toEqual([["目前的問題", "剛完成的結果"]]);
    const expired = await db.query<{ text: string }>(
      "SELECT text FROM notifications WHERE group_id IS NOT NULL AND last_error='已過期，未補送' AND sent_at IS NOT NULL ORDER BY created_at",
    );
    expect(expired.map((r) => r.text)).toEqual([
      "兩天前的結果",
      expect.stringContaining("今天的執行次數用完了"),
      "舊版的問題",
    ]);
  });

  /**
   * 模擬 LINE（依人數計費）：推播依收件對象回應；額度 API 依 opts.quota（每次呼叫時讀，可中途改）；
   * 群組人數 API 依 opts.members（null 時回 404）。
   */
  const billedApi = (opts: {
    push: (to: string) => Response;
    quota: { limit: number | null; used: number } | null;
    members: number | null;
  }) => {
    const calls = {
      pushes: [] as string[],
      messages: [] as { key: string | null; messages: { text: string }[] }[],
      quota: 0,
      members: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v2/bot/message/push")) {
          const to = JSON.parse(String(init?.body)).to;
          calls.pushes.push(to);
          calls.messages.push({
            key: new Headers(init?.headers).get("X-Line-Retry-Key"),
            messages: JSON.parse(String(init?.body)).messages,
          });
          return opts.push(to);
        }
        if (url.endsWith("/members/count")) {
          calls.members++;
          return opts.members === null
            ? Response.json({ message: "Not found" }, { status: 404 })
            : Response.json({ count: opts.members });
        }
        if (url.endsWith("/v2/bot/message/quota")) {
          calls.quota++;
          return opts.quota
            ? Response.json(
                opts.quota.limit === null
                  ? { type: "none" }
                  : { type: "limited", value: opts.quota.limit },
              )
            : Response.json({ message: "error" }, { status: 500 });
        }
        if (url.endsWith("/v2/bot/message/quota/consumption"))
          return opts.quota
            ? Response.json({ totalUsage: opts.quota.used })
            : Response.json({ message: "error" }, { status: 500 });
        return Response.json({});
      }),
    );
    return calls;
  };
  const delivered = () =>
    Response.json({ sentMessages: [{ id: "fictional-push" }] });
  const pairAdmin = (useDefaults = false) =>
    db.query(
      "UPDATE settings SET value=value||$1::jsonb WHERE id=1",
      [JSON.stringify({
        admin_line_id: "fictional-admin",
        ...(useDefaults ? {} : { line_private_mode: "all", line_group_reserve_percent: 0 }),
      })],
    );
  const ageDirect = (minutes = 11) =>
    db.query(
      "UPDATE notifications SET created_at=now()-$1::int*interval '1 minute' WHERE group_id IS NULL",
      [minutes],
    );
  const directRow = (key: string) =>
    db.one<{ sent_at: Date | null; attempts: number }>(
      "SELECT sent_at,attempts FROM notifications WHERE dedupe_key=$1",
      [key],
    );
  const setQuota = (ok: boolean, detail: string) =>
    db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',$1,$2) ON CONFLICT(name) DO UPDATE SET ok=$1,detail=$2",
      [ok, detail],
    );

  it("剩 5 則、群組 8 人：群組通知略過、不加失敗次數並說明原因；排在後面的私訊照送；額度夠時照送並在本地累加用量", async () => {
    await pairAdmin();
    const id = await task();
    // 群組通知比私訊早、而且超過一輪的 10 則：私訊不能被它們卡住。
    for (let n = 1; n <= 11; n++)
      await notifyGroup(db, id, "answered", `answered:big:${n}`, `結果 ${n}`);
    const line = new Line(db);
    await line.notify(null, "ready", "direct:1", "管理者私訊");
    await ageDirect();
    await setQuota(true, "本月已用 195／上限 200 則");
    const calls = billedApi({ push: delivered, quota: null, members: 8 });

    await line.flushNotifications();
    expect(calls.pushes).toEqual(["fictional-admin"]);
    expect((await directRow("direct:1"))?.sent_at).not.toBeNull();
    const skipped = await rows();
    expect(skipped).toHaveLength(11);
    for (const r of skipped) {
      expect(r.sent_at).toBeNull();
      expect(r.attempts).toBe(0);
      expect(r.last_error).toBe(
        "推播額度剩 5 則，不足這個群組 8 人，額度恢復後再送",
      );
    }
    // 私訊用掉 1 則，寫回說明；不必再查額度 API。
    expect(await quota()).toEqual({
      ok: true,
      detail: "本月已用 196／上限 200 則",
    });
    expect(calls.quota).toBe(0);
    expect(
      await db.one(
        "SELECT member_count FROM groups WHERE id='group-a' AND member_count_at>now()-interval '1 minute'",
      ),
    ).toEqual({ member_count: 8 });

    // 人數 24 小時內不重查；仍不夠就繼續略過，也不撞 LINE。
    await line.flushNotifications();
    expect(calls.members).toBe(1);
    expect(calls.pushes).toEqual(["fictional-admin"]);

    // 額度夠了，十一則分成三批。每一批依群組人數計八則。
    await setQuota(true, "本月已用 100／上限 200 則");
    await line.flushNotifications();
    expect(calls.messages.at(-1)?.messages).toHaveLength(5);
    for (const size of [5, 1]) {
      await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE group_id='group-a' AND sent_at IS NOT NULL");
      await line.flushNotifications();
      expect(calls.messages.at(-1)?.messages).toHaveLength(size);
    }
    expect(calls.pushes.filter((to) => to === "group-a")).toHaveLength(3);
    expect((await quota())?.detail).toBe("本月已用 124／上限 200 則");
  });

  it("群組推播撞到每月上限但額度 API 還剩 3 則：不封鎖、私訊照送；剩 0 則才封鎖並保留用量", async () => {
    await pairAdmin();
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:first", "群組結果");
    await notifyGroup(db, id, "ready", "ready:second", "群組第二則");
    const line = new Line(db);
    await line.notify(null, "ready", "direct:1", "管理者私訊");
    await ageDirect();
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '1 minute' WHERE dedupe_key='group:answered:first'",
    );
    const usage = { limit: 200, used: 197 };
    // 人數讀不到（未知），用量也還沒查過：照送，由 LINE 的 429 判斷。
    const calls = billedApi({
      push: (to) => (to === "group-a" ? monthlyLimit() : delivered()),
      quota: usage,
      members: null,
    });

    await line.flushNotifications();
    // 群組只撞一次就略過本輪其餘群組通知，私訊照送。
    // 私訊與群組分開送，誰先送出不固定；只核對兩邊各送一次。
    expect([...calls.pushes].sort()).toEqual(["fictional-admin", "group-a"]);
    expect(await quota()).toEqual({
      ok: true,
      detail: "本月已用 198／上限 200 則",
    });
    const [first, second] = await rows();
    expect(first.attempts).toBe(0);
    expect(first.last_error).toBe(
      "推播額度剩 3 則，不足這個群組的人數，額度恢復後再送",
    );
    expect(second.attempts).toBe(0);
    expect(second.sent_at).toBeNull();
    // 剩 3 則並不能推得有 4 人；人數仍未知，維持保守估值。
    const state = await app.inject({ url: "/api/state", headers });
    expect(state.json().groups.find((g: { id: string }) => g.id === "group-a")).toMatchObject({
      member_count: null, member_count_estimate: 8,
    });
    await line.flushNotifications();
    // 私訊與群組分開送，誰先送出不固定；只核對兩邊各送一次。
    expect([...calls.pushes].sort()).toEqual(["fictional-admin", "group-a"]);
    expect((await rows())[1].last_error).toBe(
      "推播額度剩 2 則，不足這個群組的人數，額度恢復後再送",
    );

    // 額度 API 顯示剩 0 則：整個封鎖，說明保留用量，私訊也不再送。
    await db.query(
      "UPDATE groups SET member_count=NULL,member_count_at=NULL WHERE id='group-a'",
    );
    await db.query("DELETE FROM service_health WHERE name='line_quota'");
    usage.used = 200;
    await line.notify(null, "ready", "direct:2", "第二則管理者私訊");
    await db.query(
      "UPDATE notifications SET created_at=now()+interval '1 minute' WHERE dedupe_key='direct:2'",
    );
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["group-a", "fictional-admin", "group-a"]);
    expect(await quota()).toEqual({
      ok: false,
      detail: `${quotaExhaustedDetail}（本月已用 200／上限 200 則）`,
    });
    expect((await directRow("direct:2"))?.sent_at).toBeNull();
    expect((await rows()).map((r) => r.attempts)).toEqual([0, 0]);
  });

  it.each([
    { scenario: "尚未能重新查得人數", members: null, cost: 12 },
    { scenario: "重新查得兩人", members: 2, cost: 2 },
  ])("人數未知且剩十一則仍被拒收，$scenario 時按 $cost 人計費", async ({ members, cost }) => {
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:estimated", "示範答案");
    billedApi({ push: monthlyLimit, quota: { limit: 200, used: 189 }, members: null });
    await line.flushNotifications();
    const dashboardGroup = async () => {
      const state = await app.inject({ url: "/api/state", headers });
      return state.json().groups.find((g: { id: string }) => g.id === "group-a");
    };
    expect(await dashboardGroup()).toMatchObject({ member_count: null, member_count_estimate: 12 });
    await setQuota(true, "本月已用 20／上限 200 則");
    if (members !== null)
      await db.query("UPDATE groups SET member_count_at=now()-interval '25 hours' WHERE id='group-a'");
    const resume = billedApi({ push: delivered, quota: null, members });
    await line.flushNotifications();
    expect(resume.pushes).toEqual(["group-a"]);
    expect(resume.members).toBe(members === null ? 0 : 1);
    expect(await dashboardGroup()).toMatchObject({ member_count: members, member_count_estimate: members === null ? 12 : null });
    expect((await quota())?.detail).toBe(`本月已用 ${20 + cost}／上限 200 則`);
  });

  it("私訊撞到每月上限就封鎖；額度 API 讀不到時沿用原本說明裡的用量，不把看板的用量蓋掉", async () => {
    await pairAdmin();
    const line = new Line(db);
    await line.notify(null, "ready", "direct:1", "管理者私訊");
    await ageDirect();
    await setQuota(true, "本月已用 150／上限 200 則");
    const calls = billedApi({
      push: () => monthlyLimit(),
      quota: null,
      members: null,
    });
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["fictional-admin"]);
    expect(calls.quota).toBe(1);
    expect(await quota()).toEqual({
      ok: false,
      detail: `${quotaExhaustedDetail}（本月已用 150／上限 200 則）`,
    });
    expect(await directRow("direct:1")).toMatchObject({
      sent_at: null,
      attempts: 0,
    });
  });

  it("預設立即將已累積的三件待辦合併成一次推播，查詢與 PR 結果留在鈴鐺", async () => {
    await pairAdmin(true);
    const line = new Line(db);
    for (const [kind, message] of [
      ["approval", "你有一件要確認"],
      ["failed", "你有一件失敗要處理"],
      ["project_input", "你有一件專案補問"],
      ["answered", "範例查詢已回覆"],
      ["ready", "範例 PR 已完成"],
    ]) await line.notify(null, kind, `direct:${kind}`, message);
    await setQuota(true, "本月已用 20／上限 200 則");
    const calls = billedApi({ push: delivered, quota: null, members: 8 });
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["fictional-admin"]);
    expect(calls.messages[0].messages).toHaveLength(1);
    const text = calls.messages[0].messages[0].text;
    for (const item of ["要確認", "失敗要處理", "專案補問", "看板：http://localhost:4310"])
      expect(text).toContain(item);
    expect(text).not.toMatch(/範例查詢已回覆|範例 PR 已完成/);
    expect((await quota())?.detail).toBe("本月已用 21／上限 200 則");
    const state = await app.inject({ url: "/api/state", headers });
    expect(state.json().alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "answered", text: "範例查詢已回覆" }),
      expect.objectContaining({ kind: "ready", text: "範例 PR 已完成" }),
    ]));
    await line.flushNotifications();
    expect(calls.pushes).toHaveLength(1);
  });

  it("群組先送，用量到 30% 時私訊暫停，下一輪群組也照送", async () => {
    await pairAdmin(true);
    const line = new Line(db);
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:example", "範例群組結果");
    await line.notify(null, "approval", "direct:hold", "你有一件要確認");
    await ageDirect();
    await setQuota(true, "本月已用 52／上限 200 則");
    const calls = billedApi({ push: delivered, quota: null, members: 8 });
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["group-a"]);
    expect((await quota())?.detail).toBe("本月已用 60／上限 200 則");
    await notifyGroup(db, id, "answered", "answered:another", "另一件範例結果");
    await db.query("UPDATE notifications SET sent_at=now()-interval '2 minutes' WHERE dedupe_key='group:answered:example'");
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["group-a", "group-a"]);
    expect(await directRow("direct:hold")).toMatchObject({ sent_at: null, attempts: 0 });
    await setQuota(true, "本月已用 1／上限 200 則");
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["group-a", "group-a", "fictional-admin"]);
  });

  it("私訊摘要重試沿用原文字與重試鍵，LINE 已收下時只記一次用量", async () => {
    await pairAdmin(true);
    const line = new Line(db);
    await line.notify(null, "approval", "direct:retry", "你有一件要確認");
    await ageDirect();
    await setQuota(true, "本月已用 58／上限 200 則");
    let response = () => new Response(null, { status: 500 });
    const calls = billedApi({ push: () => response(), quota: null, members: 8 });
    await line.flushNotifications();
    expect(await directRow("direct:retry")).toMatchObject({ sent_at: null, attempts: 1 });
    await line.notify(null, "failed", "direct:other", "你有另一件事要處理");
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '10 minutes' WHERE dedupe_key='direct:other'",
    );
    response = () => new Response(null, {
      status: 409,
      headers: { "x-line-accepted-request-id": "fictional-request-id" },
    });
    await line.flushNotifications();
    expect(calls.messages).toHaveLength(2);
    expect(calls.messages[1]).toEqual(calls.messages[0]);
    expect(await directRow("direct:retry")).toMatchObject({ sent_at: expect.any(Date), attempts: 2 });
    expect(await directRow("direct:other")).toMatchObject({ sent_at: null, attempts: 0 });
    expect((await quota())?.detail).toBe("本月已用 59／上限 200 則");
  });

  it("短暫服務中斷留在鈴鐺，持續滿 15 分鐘才納入私訊", async () => {
    await pairAdmin();
    const line = new Line(db);
    for (const name of ["github", "runner"]) {
      await db.query("DELETE FROM service_health WHERE name=$1", [name]);
      await recordHealth(db, name, true, "正常");
      await recordHealth(db, name, false, "範例服務暫時無回應");
    }
    await recordHealth(db, "github", true, "正常");
    await db.query(
      `WITH outage AS (
         UPDATE service_health SET outage_started_at=now()-interval '14 minutes'
         WHERE name='runner' RETURNING outage_started_at
       )
       UPDATE notifications SET line_outage_started_at=outage.outage_started_at,
       created_at=outage.outage_started_at FROM outage WHERE kind='service_down'
       AND dedupe_key LIKE 'service:runner:%'`,
    );
    const calls = billedApi({ push: delivered, quota: null, members: 8 });
    await line.flushNotifications();
    expect(calls.pushes).toEqual([]);
    await db.query(
      `WITH outage AS (
         UPDATE service_health SET outage_started_at=now()-interval '16 minutes'
         WHERE name='runner' RETURNING outage_started_at
       )
       UPDATE notifications SET line_outage_started_at=outage.outage_started_at,
       created_at=outage.outage_started_at FROM outage WHERE kind='service_down'
       AND dedupe_key LIKE 'service:runner:%'`,
    );
    await recordHealth(db, "runner", false, "範例服務仍無回應");
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["fictional-admin"]);
    expect(calls.messages[0].messages[0].text).toContain("隔離執行器");
    expect(calls.messages[0].messages[0].text).not.toContain("GitHub");
    expect(await db.query("SELECT 1 FROM notifications WHERE kind='service_up'")).toHaveLength(1);
    await db.query("DELETE FROM service_health WHERE name IN ('github','runner')");
  });

  it("因額度不夠群組人數而略過的通知：額度恢復續送時，過時的標成已過期、不補送；還在略過時不動", async () => {
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:old", "兩天前的結果");
    await notifyGroup(db, id, "answered", "answered:new", "剛才的結果");
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '2 days' WHERE dedupe_key='group:answered:old'",
    );
    await setQuota(true, "本月已用 195／上限 200 則");
    const calls = billedApi({ push: delivered, quota: null, members: 8 });
    const line = new Line(db);

    // 還在略過：兩則都留著（成員仍可用 /進度 取回），不推播。
    await line.flushNotifications();
    expect(calls.pushes).toEqual([]);
    expect((await rows()).map((r) => r.last_error)).toEqual([
      "推播額度剩 5 則，不足這個群組 8 人，額度恢復後再送",
      "推播額度剩 5 則，不足這個群組 8 人，額度恢復後再送",
    ]);

    // 換月後連線檢查寫入新用量：兩天前的不補送、標成已過期；剛才的照送。
    await setQuota(true, "本月已用 0／上限 200 則");
    await line.flushNotifications();
    expect(calls.pushes).toEqual(["group-a"]);
    const [old, fresh] = await rows();
    expect(old.sent_at).not.toBeNull();
    expect(old.last_error).toBe("已過期，未補送");
    expect(old.attempts).toBe(0);
    expect(fresh.sent_at).not.toBeNull();
    expect(fresh.last_error).toBeNull();
    expect((await quota())?.detail).toBe("本月已用 8／上限 200 則");
  });

  it("從沒查過額度就撞到每月上限：當場查一次用量，說明仍含「本月已用 X／上限 Y 則」", async () => {
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:first", "結果");
    lineApi({ push: monthlyLimit, quota: { limit: 200, used: 200 } });
    await new Line(db).flushNotifications();
    expect(await quota()).toEqual({
      ok: false,
      detail: `${quotaExhaustedDetail}（本月已用 200／上限 200 則）`,
    });
  });

  it("查額度失敗後才撞到上限：說明保留上次查到的用量，不被錯誤訊息洗掉", async () => {
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 150／上限 200 則')",
    );
    // 額度 API 連不上：說明寫出錯誤，但留著上次的用量。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await syncLineQuota(db, "fictional-line-token");
    expect(await quota()).toEqual({
      ok: true,
      detail: "Error: 無法連線至 LINE（上次查到本月已用 150／上限 200 則）",
    });
    // 接著推播撞到上限，額度 API 仍不通：沿用說明裡的用量。
    const id = await task();
    await notifyGroup(db, id, "answered", "answered:later", "結果");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v2/bot/message/push")) return monthlyLimit();
        throw new TypeError("fetch failed");
      }),
    );
    await new Line(db).flushNotifications();
    expect(await quota()).toEqual({
      ok: false,
      detail: `${quotaExhaustedDetail}（本月已用 150／上限 200 則）`,
    });
    // 暫停期間再查一次仍失敗：說明維持「已用完（用量）」。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await syncLineQuota(db, "fictional-line-token");
    expect((await quota())?.detail).toBe(
      `${quotaExhaustedDetail}（本月已用 150／上限 200 則）`,
    );
  });
});

describe("用 reply token 取回與說實話", () => {
  // service_health 不在 reset() 清除的資料表裡；留著會影響其他測試。
  const clearHealth = () =>
    db.query(
      "DELETE FROM service_health WHERE name IN ('line_quota','notifications','codex_subscription_gate')",
    );
  let pushes: { to: string; text: string }[];
  let replyCalls: { token: string; messages: { text: string; quickReply?: unknown }[] }[];
  let push: () => Promise<Response>;
  let replyStatus: number;
  let replyMessage: string;
  let replyTimeout: boolean;
  let connectRefused: boolean;
  beforeEach(async () => {
    await clearHealth();
    pushes = [];
    replyCalls = [];
    replyStatus = 200;
    replyMessage = "Invalid reply token";
    replyTimeout = false;
    connectRefused = false;
    push = async () =>
      Response.json({ message: "Too many requests" }, { status: 429 });
    // 模擬 LINE：reply 成功時依序回傳每則訊息的 ID（reply-第幾次-第幾則）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.endsWith("/v2/bot/message/push")) {
          pushes.push({ to: body.to, text: body.messages[0].text });
          return push();
        }
        if (url.endsWith("/v2/bot/message/reply")) {
          replyCalls.push({ token: body.replyToken, messages: body.messages });
          const n = replyCalls.length;
          if (connectRefused)
            throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) });
          if (replyTimeout)
            throw new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            );
          return replyStatus === 200
            ? Response.json({
                sentMessages: body.messages.map((_: unknown, i: number) => ({
                  id: `reply-${n}-${i}`,
                })),
              })
            : Response.json({ message: replyMessage }, { status: replyStatus });
        }
        return Response.json({});
      }),
    );
  });
  afterEach(clearHealth);

  async function send(
    id: string,
    text: string,
    opts: { quoted?: string; group?: string; timestamp?: number; redelivery?: boolean } = {},
  ) {
    const payload = JSON.stringify({
      events: [
        {
          webhookEventId: `event-${id}`,
          type: "message",
          replyToken: `fictionalReply${id.replace(/[^a-z0-9]/gi, "")}`,
          timestamp: opts.timestamp ?? Date.now(),
          deliveryContext: { isRedelivery: opts.redelivery ?? false },
          source: {
            type: "group",
            groupId: opts.group ?? "group-a",
            userId: "private-member-id",
          },
          message: { id, type: "text", text, quotedMessageId: opts.quoted },
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
  const lastReply = () => replyCalls.at(-1)!.messages.map((m) => m.text);
  const longAnswer = `重點：訂單日期欄位叫 order_date。\n\n${"細節說明。".repeat(400)}\n\n結尾段落`;
  async function answeredTask(title: string, group = "group-a") {
    const t = await db.one<{ id: string }>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,dedupe_key)
       VALUES($1,$2,$3,'摘要','[]','answered','query',$4,$5) RETURNING id`,
      [project, group, title, longAnswer, `dedupe-${title}`],
    );
    await notifyGroup(
      db,
      t!.id,
      "answered",
      `answered:${t!.id}:1`,
      `「${title}」的查詢結果：\n\n重點：訂單日期欄位叫 order_date。\n\n${detailHint}`,
    );
    return t!.id;
  }
  it("進度補送舊查詢時，只送答案與題名", async () => {
    await settings();
    const taskId = await answeredTask("範例查詢");
    const version = "a".repeat(40);
    await db.query(
      "UPDATE notifications SET text=$2 WHERE task_id=$1 AND kind='group_answered'",
      [
        taskId,
        `「範例查詢」的查詢結果：\n\n查詢專案：範例（demo/query）\n基底分支：main；查詢版本：${version}\n\n範例結論。`,
      ],
    );
    await send("legacy-query", "/進度");
    expect(lastReply().at(-1)).toBe("「範例查詢」的查詢結果：\n\n範例結論。");
  });
  async function askingTask(title: string, status = "awaiting_approval") {
    const t = await db.one<Task>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,missing,question,dedupe_key)
       VALUES($1,'group-a',$2,'匯出怪怪的','["說明匯出問題"]',$3,'query','[]',
       '{"text":"是按了沒下載，還是內容不對？","choices":["沒有下載","內容不對"]}',$4) RETURNING *`,
      [project, title, status, `dedupe-${title}`],
    );
    await askInGroup(db.pool, t!);
    return t!;
  }
  const notice = (taskId: string) =>
    db.one<{
      sent_at: Date | null;
      sent_message_id: string | null;
      last_error: string | null;
      attempts: number;
    }>(
      "SELECT sent_at,sent_message_id,last_error,attempts FROM notifications WHERE task_id=$1 AND group_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [taskId],
    );
  const setSettings = (value: Record<string, unknown>) =>
    db.query("UPDATE settings SET value=value||$1::jsonb WHERE id=1", [
      JSON.stringify(value),
    ]);

  it("推播回 429 三次後，/進度 取回查詢答案與仍有效的補問；「詳細」與引用作答都接得上", async () => {
    await settings();
    const answered = await answeredTask("查訂單欄位");
    const asking = await askingTask("匯出問題");
    const line = new Line(db);
    for (let n = 0; n < 3; n++) await line.flushNotifications();
    expect(pushes).toHaveLength(3);
    expect((await notice(answered)).attempts).toBe(3);
    // 試滿 3 次後推播不再送，只能靠 /進度 取回。
    await line.flushNotifications();
    expect(pushes).toHaveLength(3);

    await send("p1", "/進度");
    expect(replyCalls).toHaveLength(1);
    const [summary, answer, question] = lastReply();
    expect(lastReply()).toHaveLength(3);
    expect(summary).toContain("- 查訂單欄位：已回答");
    expect(summary).toContain("- 匯出問題：等你們回答一個問題");
    expect(answer).toContain("「查訂單欄位」的查詢結果");
    expect(answer).toContain(detailHint);
    expect(question).toContain("是按了沒下載，還是內容不對？");
    expect(await notice(answered)).toMatchObject({
      sent_message_id: "reply-1-1",
      last_error: null,
    });
    expect((await notice(answered)).sent_at).not.toBeNull();
    expect((await notice(asking.id)).sent_message_id).toBe("reply-1-2");
    // /進度 本身不建任務、不排判讀。
    const saved = await db.one<{ trigger_mode: string; processed: boolean }>(
      "SELECT trigger_mode,processed FROM messages WHERE id='p1'",
    );
    expect(saved).toEqual({ trigger_mode: "chat", processed: true });

    // 引用補送的答案打「詳細」拿到全文。
    await send("d1", "詳細", { quoted: "reply-1-1" });
    expect(lastReply()).toEqual(lineChunks(longAnswer));
    // 引用補送的補問直接回答，會被 applyAnswer 收下。
    await send("a1", "沒有下載", { quoted: "reply-1-2" });
    const after = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      asking.id,
    ]);
    expect(after.question).toBeNull();
    expect(after.version).toBe(asking.version + 1);
    expect([answerAck, answerHeldAck]).toContain(lastReply()[0]);

    // 都取回了：再打一次只回摘要並說明沒有待取回的結果。
    await send("p2", "/進度");
    expect(lastReply()).toHaveLength(1);
    expect(lastReply()[0]).toContain("目前沒有待取回的結果");
  });

  it("只取本群組、仍有效、每個需求最新的一則；超過 4 則時提示再輸入 /進度", async () => {
    await settings();
    await db.query(
      "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','另一個群組',true,'command')",
    );
    await answeredTask("另一群組的查詢", "group-b");
    const oldVersion = await askingTask("舊版補問");
    await db.query("UPDATE tasks SET version=version+1 WHERE id=$1", [
      oldVersion.id,
    ]);
    const cancelled = await askingTask("已取消的補問", "cancelled");
    const merged = await task("已合併的修改");
    await notifyGroup(db, merged, "ready", "ready:old", "PR 已完成");
    await notifyGroup(db, merged, "merged", "merged:new", "PR 已合併");
    await tellGroupWaiting(db, merged, "daily");
    for (const n of [1, 2, 3, 4]) await answeredTask(`查詢 ${n}`);

    await send("p1", "/進度");
    const texts = lastReply();
    expect(texts).toHaveLength(5);
    expect(texts[0]).not.toContain("另一群組的查詢");
    const all = texts.join("\n");
    for (const hidden of [
      "另一群組的查詢",
      "PR 已完成",
      "是按了沒下載",
      "今天的執行次數用完了",
    ])
      expect(texts.slice(1).join("\n")).not.toContain(hidden);
    expect(texts[1]).toBe("PR 已合併");
    expect(all).toContain("「查詢 1」的查詢結果");
    expect(texts[4]).toContain("「查詢 3」的查詢結果");
    expect(texts[4]).toContain("還有 1 則，再輸入 /進度。");

    await send("p2", "/進度");
    expect(lastReply()).toHaveLength(2);
    expect(lastReply()[1]).toContain("「查詢 4」的查詢結果");
    expect(lastReply()[1]).not.toContain("還有");
    // 舊的、過期的、其他群組的都沒被動到；同一需求較舊的那則標成已被取代。
    expect((await notice(oldVersion.id)).sent_at).toBeNull();
    expect((await notice(cancelled.id)).sent_at).toBeNull();
    expect(
      await db.one<{ sent_at: Date | null }>(
        "SELECT sent_at FROM notifications WHERE group_id='group-b'",
      ),
    ).toEqual({ sent_at: null });
    const ready = await db.one<{ sent_at: Date | null; last_error: string }>(
      "SELECT sent_at,last_error FROM notifications WHERE dedupe_key='group:ready:old'",
    );
    expect(ready?.sent_at).not.toBeNull();
    expect(ready?.last_error).toBe("已有較新的回覆，未補送");

    await send("p3", "/進度");
    expect(lastReply()).toHaveLength(1);
  });

  it("自動接續的進度只在接續還沒結束時取回；接續結束後過期，不補送", async () => {
    await settings();
    const resumed = await task("範例報表加上日期");
    await db.query("UPDATE tasks SET status='queued' WHERE id=$1", [resumed]);
    await notifyGroup(
      db,
      resumed,
      "resumed",
      `resumed:${resumed}:1`,
      autoResumeText("verify"),
    );
    await send("r1", "/進度");
    expect(lastReply().join("\n")).toContain("自動接續測試與審查");

    const finished = await task("範例清單排序");
    await notifyGroup(
      db,
      finished,
      "resumed",
      `resumed:${finished}:1`,
      autoResumeText("repair"),
    );
    await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [finished]);
    await send("r2", "/進度");
    expect(lastReply().join("\n")).not.toContain("自動接續修復");
    await db.transaction((c) => expireStaleNotifications(c));
    expect(
      await db.one<{ last_error: string }>(
        "SELECT last_error FROM notifications WHERE kind='group_resumed' AND task_id=$1",
        [finished],
      ),
    ).toEqual({ last_error: expiredNote });
  });
  it("自動接續的進度只屬於當時的需求版本：任務改成新版本再排隊時不取回、過期不補送", async () => {
    await settings();
    const id = await task("範例報表加上日期");
    await notifyGroup(
      db,
      id,
      "resumed",
      `resumed:${id}:1`,
      autoResumeText("verify"),
    );
    // 新版本核准後回到排隊：「已保留目前的修改」對新版本不成立。
    await db.query(
      "UPDATE tasks SET status='queued',version=2,approved_version=2 WHERE id=$1",
      [id],
    );
    await send("r1", "/進度");
    expect(lastReply().join("\n")).not.toContain("自動接續");
    await db.transaction((c) => expireStaleNotifications(c));
    expect(
      await db.one<{ last_error: string }>(
        "SELECT last_error FROM notifications WHERE kind='group_resumed' AND task_id=$1",
        [id],
      ),
    ).toEqual({ last_error: expiredNote });
  });
  it("同一任務再次失敗：舊的失敗說明過期不補送，群組只收到最新一次失敗", async () => {
    await settings();
    const id = await task("範例清單排序");
    await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [id]);
    await notifyGroup(db, id, "failed", `failed:${id}`, "第一次失敗：沒有自動接續");
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '1 day' WHERE task_id=$1",
      [id],
    );
    await notifyGroup(db, id, "failed", `failed:${randomUUID()}`, "第二次失敗：已接續過");
    await db.transaction((c) => expireStaleNotifications(c));
    const rows = await db.query<{ text: string; last_error: string | null }>(
      "SELECT text,last_error FROM notifications WHERE kind='group_failed' AND task_id=$1 ORDER BY created_at",
      [id],
    );
    expect(rows).toEqual([
      { text: "第一次失敗：沒有自動接續", last_error: expiredNote },
      { text: "第二次失敗：已接續過", last_error: null },
    ]);
    await send("r1", "/進度");
    expect(lastReply().join("\n")).toContain("第二次失敗");
    expect(lastReply().join("\n")).not.toContain("第一次失敗");
  });
  it("「收到需求」和補問在同一交易排入時，/進度 送的是補問，不會把補問當成已被取代", async () => {
    await settings({ reply_mode: "all" });
    // 判讀建立需要人工確認、又帶補問的任務時，approvalNotice 與 askInGroup 在同一交易，created_at 相同。
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const t = await db.one<Task>(
        `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,missing,question,dedupe_key)
         VALUES($1,'group-a',$2,'匯出怪怪的','["說明匯出問題"]','awaiting_approval','query','[]',
         '{"text":"是按了沒下載，還是內容不對？","choices":[]}',$3) RETURNING *`,
        [project, `同批補問 ${n}`, `dedupe-same-${n}`],
      );
      await db.transaction(async (c) => {
        await approvalNotice(c, t!);
        await askInGroup(c, t!);
      });
      ids.push(t!.id);
    }
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE group_id='group-a' AND kind='group_received'",
      ),
    ).toHaveLength(4);

    await send("p1", "/進度");
    const notes = lastReply().slice(1);
    expect(notes).toHaveLength(4);
    for (const text of notes) {
      expect(text).toContain("是按了沒下載，還是內容不對？");
      expect(text).not.toContain("等管理者確認後開始處理");
    }
    // 補問都寫回了訊息 ID，可以直接「回覆」作答；同批的「收到」標成已被取代，不會下次再冒出來。
    for (const id of ids)
      expect(
        (
          await db.one<{ sent_message_id: string | null }>(
            "SELECT sent_message_id FROM notifications WHERE task_id=$1 AND kind='group_question'",
            [id],
          )
        )?.sent_message_id,
      ).toMatch(/^reply-1-/);
    await send("p2", "/進度");
    expect(lastReply()).toHaveLength(1);
    expect(lastReply()[0]).toContain("目前沒有待取回的結果");
  });

  it("/進度 與推播同時執行不會重複送出；reply 失敗時通知回到未送出", async () => {
    await settings();
    for (const n of [1, 2, 3]) await answeredTask(`查詢 ${n}`);
    push = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return Response.json({ sentMessages: [{ id: "fictional-push" }] });
    };
    await Promise.all([send("p1", "/進度"), new Line(db).flushNotifications()]);
    const delivered = [
      ...pushes.map((p) => p.text),
      ...replyCalls.flatMap((r) => r.messages.slice(1).map((m) => m.text)),
    ];
    for (const n of [1, 2, 3])
      expect(delivered.filter((t) => t.includes(`「查詢 ${n}」`))).toHaveLength(
        1,
      );
    expect(
      await db.query("SELECT 1 FROM notifications WHERE sent_at IS NULL"),
    ).toHaveLength(0);

    replyCalls = [];
    const id = await answeredTask("查詢 4");
    replyStatus = 400;
    await send("p2", "/進度");
    expect(replyCalls).toHaveLength(1);
    expect(await notice(id)).toMatchObject({
      sent_at: null,
      sent_message_id: null,
      last_error: replyFailedNote,
    });
    // 下一次 /進度 可以再取。
    replyStatus = 200;
    await send("p3", "/進度");
    expect(lastReply()[1]).toContain("「查詢 4」的查詢結果");
    expect((await notice(id)).sent_message_id).toBe("reply-2-1");
  });

  const failures = async (taskId: string) =>
    (await db.one<{ reply_failures: number }>(
      "SELECT reply_failures FROM notifications WHERE task_id=$1 AND group_id IS NOT NULL",
      [taskId],
    ))!.reply_failures;

  it.each(["已到期", "已由下一輪領取"] as const)(
    "補送前保留租約所有權：%s 的通知不再送出",
    async (state) => {
      await settings();
      const id = await answeredTask("租約狀態範例");
      // 在收訊交易提交與送出之間切換這一列的狀態，不必等待兩分鐘或啟動平行程序。
      const transaction = db.transaction.bind(db);
      const changeLease = vi
        .spyOn(db, "transaction")
        .mockImplementationOnce(async (fn) => {
          const result = await transaction(fn);
          await db.query(
            `UPDATE notifications SET sent_at=CASE WHEN $2='已到期' THEN now()-interval '3 minutes' ELSE clock_timestamp() END
           WHERE task_id=$1 AND last_error=$3`,
            [id, state, claimingNote],
          );
          return result;
        });
      try {
        await send("lease", "/進度");
      } finally {
        changeLease.mockRestore();
      }
      expect(
        replyCalls.flatMap((call) => call.messages.map((m) => m.text)),
      ).not.toEqual(
        expect.arrayContaining([expect.stringContaining(detailHint)]),
      );
      const current = await notice(id);
      expect(current.sent_message_id).toBeNull();
      if (state === "已由下一輪領取") {
        expect(current.sent_at).not.toBeNull();
        expect(current.last_error).toBe(claimingNote);
      }
    },
  );

  it.each([200, 503])(
    "補送等待 LINE 回應時釋放資料列鎖，但下一輪仍無法重領（HTTP %i）",
    async (status) => {
      await settings();
      const id = await answeredTask("等待寫回結果的範例");
      let unlocked: number | undefined;
      let nextClaim: string[] | undefined;
      vi.stubGlobal("fetch", async () => {
        await db.transaction(async (c) => {
          unlocked = (await c.query(
            "SELECT id FROM notifications WHERE task_id=$1 AND last_error=$2 FOR UPDATE SKIP LOCKED",
            [id, claimingNote],
          )).rows.length;
          const pending = await claimPendingGroupReplies(c, "group-a", 4);
          nextClaim = pending.replies.map((notice) => notice.id);
        });
        return Response.json(
          { sentMessages: [{ id: "summary" }, { id: "reply-result" }] },
          { status },
        );
      });
      await send("settle-lease", "/進度");
      expect(unlocked).toBe(1);
      expect(nextClaim).toEqual([]);
      expect(await notice(id)).toMatchObject(
        status === 200
          ? { sent_message_id: "reply-result", last_error: null }
          : {
              sent_message_id: null,
              sent_at: null,
              last_error: replyFailedNote,
            },
      );
    },
  );

  it("佔住後程序中止（沒寫回 reply 結果）：超過 2 分鐘由通知排程放回待送，下一次 /進度 取得回", async () => {
    await settings();
    const id = await answeredTask("中止時的查詢");
    // 模擬收訊交易提交後、reply 結果寫回前程序中止：只佔住，不呼叫 settle。
    await db.transaction((c) => claimPendingGroupReplies(c, "group-a", 4));
    expect(await notice(id)).toMatchObject({
      sent_message_id: null,
      last_error: claimingNote,
    });
    // 額度用完、推播暫停時也要收回：那時 /進度 是唯一的取回管道。
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',false,'LINE 本月推播額度已用完')",
    );
    const line = new Line(db);
    // 剛佔住的可能正在 reply，不收回。
    await line.flushNotifications();
    expect((await notice(id)).last_error).toBe(claimingNote);
    expect((await notice(id)).sent_at).not.toBeNull();

    await db.query(
      "UPDATE notifications SET sent_at=now()-interval '3 minutes' WHERE task_id=$1",
      [id],
    );
    await line.flushNotifications();
    expect(await notice(id)).toMatchObject({
      sent_at: null,
      sent_message_id: null,
      last_error: replyFailedNote,
    });
    expect(pushes).toHaveLength(0);

    await send("p1", "/進度");
    expect(lastReply()[1]).toContain("「中止時的查詢」的查詢結果");
    expect((await notice(id)).sent_message_id).toBe("reply-1-1");
  });

  it("補送被 LINE 以內容問題拒收兩次就不再取回，之後的 /進度 照常回摘要；5xx、逾時、reply token 失效不累加", async () => {
    await settings();
    const broken = await answeredTask("內容壞掉的查詢");
    replyStatus = 400;
    replyMessage = "The request body has 1 error(s)";
    await send("p1", "/進度");
    expect(await failures(broken)).toBe(1);
    expect(await notice(broken)).toMatchObject({
      sent_at: null,
      last_error: replyFailedNote,
    });
    await send("p2", "/進度");
    expect(replyCalls).toHaveLength(2);
    expect(await failures(broken)).toBe(2);
    expect(await notice(broken)).toMatchObject({
      sent_at: null,
      sent_message_id: null,
      last_error: replyGaveUpNote,
    });

    // 第三次：不再挑到它，至少回得出摘要。
    replyStatus = 200;
    await send("p3", "/進度");
    expect(lastReply()).toHaveLength(1);
    expect(lastReply()[0]).toContain("- 內容壞掉的查詢：已回答");
    expect(lastReply()[0]).toContain("目前沒有待取回的結果");
    // 「收到」的 /進度 提示也不再算它。
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',false,'LINE 本月推播額度已用完')",
    );
    await send("m1", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([commandAck]);
    await db.query("DELETE FROM service_health WHERE name='line_quota'");

    // 不是內容的問題：LINE 5xx、逾時、reply token 失效都不累加。
    const flaky = await answeredTask("暫時送不出的查詢");
    replyStatus = 500;
    replyMessage = "Internal server error";
    await send("p4", "/進度");
    replyStatus = 400;
    replyMessage = "Invalid reply token";
    await send("p5", "/進度");
    replyStatus = 200;
    replyTimeout = true;
    await send("p6", "/進度");
    // p1、p2、p3、m1，再加上這三次。
    expect(replyCalls).toHaveLength(7);
    expect(await failures(flaky)).toBe(0);
    expect(await notice(flaky)).toMatchObject({
      sent_at: null,
      sent_message_id: null,
    });
    replyTimeout = false;
    await send("p7", "/進度");
    expect(lastReply()[1]).toContain("「暫時送不出的查詢」的查詢結果");
    expect((await notice(flaky)).sent_message_id).toBe("reply-8-1");
  });

  it("/進度表 不觸發；不回覆設定或總開關關閉時不回；群組停用時說明沒有啟用", async () => {
    await settings();
    await send("p1", "/進度表");
    await send("p2", "有人說 /進度");
    expect(replyCalls).toHaveLength(0);

    await answeredTask("查詢");
    await settings({ reply_mode: "off" });
    await send("p3", "/進度");
    expect(replyCalls).toHaveLength(0);

    await settings({ reply_mode: "results" });
    await setSettings({ group_replies: false });
    await send("p4", "/進度");
    expect(replyCalls).toHaveLength(0);

    await setSettings({ group_replies: true });
    await settings({ enabled: false });
    await send("p5", "/進度");
    expect(lastReply()).toEqual([disabledAck]);
    // 都沒有被補送。
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE group_id='group-a' AND sent_at IS NULL",
      ),
    ).toHaveLength(1);
  });

  it("「收到」依暫停、判讀暫停、沒有可用專案、AI 額度關閉說明；正常時維持原文字", async () => {
    await settings();
    await send("m0", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([commandAck]);

    await setSettings({ paused: true });
    await send("m1", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([pausedAck]);

    await setSettings({ paused: false, triage_paused: true });
    await send("m2", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([pausedAck]);

    // 引用機器人回答的追問也套用同一套判斷。
    const answered = await answeredTask("查訂單欄位");
    await db.query(
      "UPDATE notifications SET sent_at=now(),sent_message_id='bot-answer' WHERE task_id=$1",
      [answered],
    );
    await send("m3", "那出貨日期呢？", { quoted: "bot-answer" });
    expect(lastReply()).toEqual([pausedAck]);

    await setSettings({ triage_paused: false, ai_mode: "subscription" });
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('codex_subscription_gate',false,'Codex 訂閱額度已達上限')",
    );
    await send("m4", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([aiQuotaAck]);
    // API 模式不看訂閱額度關卡。
    await setSettings({ ai_mode: "api" });
    await send("m5", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([commandAck]);
  });

  it("沒有可用專案時說明已記下；訊息維持待判讀，專案重新驗證後會被判讀", async () => {
    await settings();
    await db.query("UPDATE projects SET validated_at=NULL WHERE id=$1", [
      project,
    ]);
    await send("m1", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([noProjectAck]);
    expect(
      await db.one<{ processed: boolean; trigger_mode: string }>(
        "SELECT processed,trigger_mode FROM messages WHERE id='m1'",
      ),
    ).toEqual({ processed: false, trigger_mode: "command" });
    await db.query(
      "UPDATE groups SET first_pending_at=now()-interval '10 minutes',last_pending_at=now()-interval '10 minutes'",
    );
    expect(await dueTriageGroups(db, "group-a")).toHaveLength(0);

    await db.query("UPDATE projects SET validated_at=now() WHERE id=$1", [
      project,
    ]);
    expect((await dueTriageGroups(db, "group-a")).map((g) => g.id)).toEqual([
      "group-a",
    ]);
  });

  it("推播額度用完時，群組下一則普通發言直接帶出本群組的重要結果與補問", async () => {
    await settings();
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',false,'LINE 本月推播額度已用完')",
    );
    const answer = await answeredTask("示範報表");
    await db.query(
      "UPDATE notifications SET text=text||' password=ExampleKey123' WHERE task_id=$1",
      [answer],
    );
    const question = await askingTask("示範匯出");
    const stale = await askingTask("過期問題", "cancelled");
    const waiting = await task("等候整理");
    await notifyGroup(db, waiting, "received", "received:demo", "等候整理的中間進度");
    await db.query("INSERT INTO groups(id,name,enabled) VALUES('group-b','群組乙',true)");
    const other = await answeredTask("群組乙的查詢", "group-b");

    await send("chat", "大家早安");
    expect(replyCalls).toHaveLength(1);
    const messages = lastReply().join("\n");
    expect(messages).toContain("示範報表");
    expect(messages).toContain("是按了沒下載，還是內容不對？");
    expect(messages).toContain("[已遮蔽]");
    expect(messages).not.toMatch(/ExampleKey123|等候整理的中間進度|群組乙的查詢|過期問題/);
    expect((await notice(answer)).sent_message_id).toMatch(/^reply-1-/);
    expect((await notice(question.id)).sent_message_id).toMatch(/^reply-1-/);
    for (const id of [stale.id, other, waiting]) expect((await notice(id)).sent_at).toBeNull();
    await send("chat", "大家早安");
    expect(replyCalls).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it("指令的收到與待送結果共用一次免費回覆，送達後不再推播", async () => {
    await settings();
    const answer = await answeredTask("示範日期");
    await send("command", "/任務 更新日期");
    expect(replyCalls).toHaveLength(1);
    expect(lastReply()[0]).toBe(commandAck);
    expect(lastReply()[1]).toContain("示範日期");
    expect((await notice(answer)).sent_message_id).toBe("reply-1-1");
    await line.flushNotifications();
    expect(pushes).toHaveLength(0);
  });

  it.each([
    { firstMessage: "早安", cause: "逾時", status: 200 },
    { firstMessage: "/進度", cause: "逾時", status: 200 },
    { firstMessage: "早安", cause: "伺服器錯誤", status: 503 },
  ])("「$firstMessage」的免費回覆發生$cause 後，冷卻期間成員可輸入 /進度 取回", async ({ firstMessage, status }) => {
    await settings();
    const id = await answeredTask("示範回答");
    replyTimeout = status === 200;
    replyStatus = status;
    await send("initial", firstMessage);
    expect(lastReply().join("\n")).toContain("示範回答");
    replyTimeout = false;
    replyStatus = 200;
    await line.flushNotifications();
    expect(pushes).toHaveLength(0);
    await send("ordinary", "午安");
    expect(replyCalls).toHaveLength(1);

    replyStatus = 400;
    await send("expiredToken", "/進度");
    expect(lastReply().join("\n")).toContain("示範回答");
    await line.flushNotifications();
    expect(pushes).toHaveLength(0);
    expect(replyCalls).toHaveLength(2);
    const chat = await app.inject({ url: "/api/groups/group-a/messages", headers });
    const { delivery } = chat.json().bot_messages.find((m: { task_id: string }) => m.task_id === id);
    expect(deliveryLabel(delivery)).toBe("送達待確認");
    expect(deliveryNotice(delivery, "group_answered")).toContain("/進度");

    replyStatus = 200;
    await send("retrieve", "/進度");
    expect(lastReply()[0]).not.toContain("先前沒送到");
    expect(lastReply()[1]).toContain("示範回答");
    expect((await notice(id)).sent_message_id).toBe("reply-3-1");
    await send("done", "/進度");
    expect(lastReply()).toHaveLength(1);
  });

  it("補問免費回覆逾時後，冷卻五分鐘才在群組發言時補送，保留前綴與作答按鈕", async () => {
    await settings();
    const asking = await askingTask("範例匯出問題");
    replyTimeout = true;
    await send("firstQuestion", "早安");
    replyTimeout = false;
    await send("earlyQuestion", "午安");
    expect(replyCalls).toHaveLength(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    try {
      await line.flushNotifications();
      expect(pushes).toHaveLength(0);
      expect(replyCalls).toHaveLength(1);
      await send("retryQuestion", "晚安");
      expect(replyCalls).toHaveLength(2);
      expect(lastReply()[0]).toMatch(/^（補送：先前可能沒送到，看過可略過）/);
      expect(lastReply()[0]).toContain("是按了沒下載");
      expect(replyCalls[0].messages[0]).toHaveProperty("quickReply.items");
      expect(replyCalls[1].messages[0].quickReply).toEqual(replyCalls[0].messages[0].quickReply);
      expect((await notice(asking.id)).sent_message_id).toBe("reply-2-0");
    } finally {
      clock.mockRestore();
    }
  });

  it("重要答案補送仍遇到伺服器錯誤時，後續指令只附未確認數量，成員仍可用 /進度 取回", async () => {
    await settings();
    const id = await answeredTask("範例運費答案");
    replyStatus = 503;
    await send("firstAnswer", "早安");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 301000);
    try {
      await send("retryAnswer", "午安");
      expect(replyCalls).toHaveLength(2);
      replyStatus = 200;
      clock.mockReturnValue(now + 602000);
      await send("plain", "晚安");
      expect(replyCalls).toHaveLength(2);
      await send("command", "/任務 新增匯出欄位");
      expect(lastReply().join("\n")).toContain("有 1 則回覆不確定是否送達，需要時輸入 /進度 取回");
      expect(lastReply().join("\n")).not.toContain("範例運費答案");
      await line.flushNotifications();
      expect(pushes).toHaveLength(0);
      await send("manual", "/進度");
      expect(lastReply().at(-1)).toContain("範例運費答案");
      expect((await notice(id)).sent_message_id).toBe("reply-4-1");
    } finally {
      clock.mockRestore();
    }
  });

  it("免費回覆建立連線遭拒時，排程仍能推播該則回答", async () => {
    await settings();
    const id = await answeredTask("連線恢復後的回答");
    connectRefused = true;
    await send("connect", "早安");
    connectRefused = false;
    push = async () => Response.json({ sentMessages: [{ id: "ExamplePush1" }] });
    await line.flushNotifications();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).toContain("連線恢復後的回答");
    expect((await notice(id)).sent_message_id).toBe("ExamplePush1");
  });

  it("額度充足的摘要提示可用 /進度 取回，其餘結果可在群組再發言前推播", async () => {
    await settings();
    await db.query("INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 12／上限 200 則')");
    for (let i = 1; i <= 6; i++) await answeredTask(`虛構結果${i}`);
    push = async () => Response.json({ sentMessages: [{ id: "ExamplePush2" }] });
    await send("summary", "早安");
    const summary = lastReply().at(-1)!;
    expect(summary).toContain("虛構結果6");
    expect(summary).toContain("/進度");
    expect(summary).not.toContain("下次群組發言時會繼續補送");
    await line.flushNotifications();
    expect(pushes.map((call) => call.text).join("\n")).toContain("虛構結果6");
  });

  it("重要結果超過五則時，同一個回覆也會摘要其餘項目，仍可取回可引用的原訊息", async () => {
    await settings();
    for (let i = 1; i <= 6; i++) await answeredTask(`範例結果${i}`);
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',false,'LINE 本月推播額度已用完')",
    );
    await send("summary", "早安");
    expect(replyCalls).toHaveLength(1);
    expect(lastReply().length).toBeLessThanOrEqual(5);
    for (let i = 1; i <= 6; i++) expect(lastReply().join("\n")).toContain(`範例結果${i}`);
    expect(lastReply().join("\n")).toContain("/進度");
    await send("progress", "/進度");
    expect(lastReply().some((text) => text.includes(detailHint))).toBe(true);
  });

  it("同時有兩個補問時，回覆的最後一則保留可點的問題，另一題列在摘要等下次發言", async () => {
    await settings();
    const a = await askingTask("第一題");
    const b = await askingTask("第二題");
    await answeredTask("可先閱讀的結果");
    await send("questions", "早安");
    expect(lastReply().at(-1)).toContain("第一題");
    expect(replyCalls[0].messages.at(-1)).toHaveProperty("quickReply.items");
    expect(lastReply().join("\n")).toContain("第二題");
    expect(lastReply().join("\n")).toContain("可先閱讀的結果");
    expect((await notice(a.id)).sent_message_id).not.toBeNull();
    expect((await notice(b.id)).sent_at).toBeNull();
    await send("next", "還有嗎");
    expect(lastReply().at(-1)).toContain("第二題");
    expect(replyCalls[1].messages.at(-1)).toHaveProperty("quickReply.items");
  });

  it("一般發言後一分鐘內排入的通知優先用還沒用過的回覆，之後不重用權杖", async () => {
    await settings();
    await send("recent", "大家早安");
    expect(replyCalls).toHaveLength(0);
    const answer = await answeredTask("剛完成的查詢");
    await line.flushNotifications();
    expect(replyCalls.map((call) => call.token)).toEqual(["fictionalReplyrecent"]);
    expect(lastReply().join("\n")).toContain("剛完成的查詢");
    expect((await notice(answer)).sent_message_id).toMatch(/^reply-1-/);
    expect(pushes).toHaveLength(0);
    await answeredTask("後來的查詢");
    await line.flushNotifications();
    expect(replyCalls).toHaveLength(1);
  });

  it("過期發言與已關閉回覆的群組都不消耗回覆權杖", async () => {
    await settings();
    await send("expired", "早安", { timestamp: Date.now() - 61000 });
    await send("unused", "午安");
    await answeredTask("示範進度");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    try {
      await line.flushNotifications();
    } finally {
      clock.mockRestore();
    }
    expect(replyCalls).toHaveLength(0);
    await settings({ reply_mode: "off" });
    await send("off", "有人嗎");
    expect(replyCalls).toHaveLength(0);
    await settings({ reply_mode: "results" });
    await setSettings({ group_replies: false });
    await send("systemOff", "有人嗎");
    await line.flushNotifications();
    expect(replyCalls).toHaveLength(0);
  });

  it("免費回覆也能送出收到通知，權杖失效後留給下一次發言重試", async () => {
    await settings({ reply_mode: "all" });
    const id = await task("示範修改");
    await notifyGroup(db, id, "received", "received:reply", "已收到示範修改", "all");
    replyStatus = 400;
    replyMessage = "Invalid reply token";
    await send("oldReply", "早安");
    expect(lastReply()).toEqual(["已收到示範修改"]);
    expect(await notice(id)).toMatchObject({ sent_at: null, attempts: 0, last_error: replyFailedNote });
    expect(await failures(id)).toBe(0);
    replyStatus = 200;
    await send("newReply", "午安");
    expect(lastReply()).toEqual(["已收到示範修改"]);
    expect((await notice(id)).sent_message_id).toBe("reply-2-0");
    expect(pushes).toHaveLength(0);
  });

  it.each([false, true])("延遲送達且首次收到的事件，可在收件後一分鐘回覆一次（重送 %s）", async (redelivery) => {
    await settings();
    await answeredTask("範例結果");
    const event = { timestamp: Date.now() - 2 * 60_000, redelivery };
    await send("delayed", "/任務 示範調整", event);
    await send("delayed", "/任務 示範調整", { ...event, redelivery: true });
    expect(replyCalls).toHaveLength(1);
    expect(lastReply()[0]).toBe(commandAck);
    expect(lastReply()[1]).toContain("範例結果");
  });

  it("原事件已過二十分鐘的重送不消耗權杖，待送結果留給下一則有效發言", async () => {
    await settings();
    const answer = await answeredTask("範例效期");
    await send("late", "/進度", { timestamp: Date.now() - 20 * 60_000, redelivery: true });
    expect(replyCalls).toHaveLength(0);
    expect((await notice(answer)).sent_at).toBeNull();
    await send("fresh", "早安");
    expect(lastReply().join("\n")).toContain("範例效期");
  });

  it.each([
    { status: 400, message: "The request body has 1 error(s)", calls: 2 },
    { status: 400, message: "Invalid reply token", calls: 1 },
    { status: 503, message: "Internal server error", calls: 1 },
  ])("指令併送遭 HTTP $status 拒收，只在確認內容問題時單送指令回覆（$message）", async ({ status, message, calls }) => {
    await settings();
    const answer = await answeredTask("等待補送的答案");
    const payloads: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { messages } = JSON.parse(String(init.body)) as { messages: { text: string }[] };
      payloads.push(messages.map((m) => m.text));
      return messages.length > 1
        ? Response.json({ message }, { status })
        : Response.json({ sentMessages: [{ id: "Confirmed" }] });
    });
    await send("ack", "/任務 範例修改");
    expect(payloads).toHaveLength(calls);
    if (calls === 2) expect(payloads[1]).toEqual([commandAck]);
    expect((await notice(answer)).sent_at).toBeNull();
  });
});
