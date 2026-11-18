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
const line = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-chat-secret",
    lineToken: line.token,
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Triage, type Classifier } from "../server/triage.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { downloadPendingImages } from "../server/maintenance.js";
import { notifyGroup } from "../server/group-replies.js";
import type { TriageDecision } from "../shared/types.js";
import type { ChatPage } from "../shared/chat.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Awaited<ReturnType<typeof session>>;
let project: string;
beforeEach(async () => {
  await reset();
  project = await fixture();
  headers = await session();
  app = await buildApp(db);
  await mode("command");
});
afterEach(async () => {
  await app.close();
  line.token = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => db.close());
async function mode(trigger_mode?: "auto" | "command", extra = {}) {
  return app.inject({
    method: "PUT",
    url: "/api/groups/group-a",
    headers,
    payload: {
      name: "測試群組",
      project_ids: [project],
      enabled: true,
      trigger_mode,
      ...extra,
    },
  });
}
async function receive(
  id: string,
  text: string | undefined,
  type = "text",
  quotedMessageId?: string,
  groupId = "group-a",
) {
  const payload = JSON.stringify({
    events: [
      {
        webhookEventId: `event-${id}`,
        type: "message",
        source: { type: "group", groupId, userId: "private-member-id" },
        message: { id, type, text, quotedMessageId },
      },
    ],
  });
  const r = await app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-chat-secret")
        .update(payload)
        .digest("base64"),
    },
  });
  expect(r.statusCode).toBe(200);
}
const decision = (
  sourceIds: string[],
  kind: TriageDecision["kind"] = "request",
): TriageDecision => ({
  kind,
  projectId: project,
  title: "調整按鈕顏色",
  summary: "將首頁按鈕改成綠色",
  acceptance: ["首頁按鈕呈現綠色"],
  sourceIds,
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
});
function triage(classify: Classifier["classify"]) {
  const github = new GitHub();
  github.context = async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "test-base",
    paths: [],
    files: {},
    truncated: false,
  });
  return new Triage(db, { classify }, github, new Line(db), new Budget(db));
}
async function page(before?: string): Promise<ChatPage> {
  const r = await app.inject({
    url: `/api/groups/group-a/messages${before ? `?before=${before}` : ""}`,
    headers,
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return r.json();
}

describe("聊天室與明確指令派工", () => {
  it("冒號與換行指令可以觸發；缺少圖片時只建立一張待審核任務", async () => {
    await receive("pic", undefined, "image");
    await receive("cmd-colon", "/任務：照圖改按鈕", "text", "pic");
    await receive("cmd-newline", "/任務\n照圖改按鈕");
    const classify = vi.fn<Classifier["classify"]>(async (input) => {
      expect(
        input.messages
          .filter((m) => !m.contextOnly)
          .map((m) => m.id)
          .sort(),
      ).toEqual(["cmd-colon", "cmd-newline"]);
      return [
        decision(["cmd-colon", "cmd-newline"]),
        decision(["pic"], "ignore"),
      ];
    });
    await triage(classify).process("group-a");
    const tasks = await db.query<{ status: string; source_ids: string[] }>(
      "SELECT status,source_ids FROM tasks",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("awaiting_approval");
    expect(tasks[0].source_ids.sort()).toEqual([
      "cmd-colon",
      "cmd-newline",
      "pic",
    ]);
  });
  it("模型判讀期間引用圖片被撤回時，不接受舊結果", async () => {
    await receive("pic", undefined, "image");
    await db.query(
      "UPDATE messages SET image=$1,image_mime='image/png' WHERE id='pic'",
      [Buffer.from("image")],
    );
    await receive("cmd", "/任務 按圖改按鈕", "text", "pic");
    await expect(
      triage(async () => {
        await new Line(db).ingest({
          events: [
            {
              webhookEventId: "withdraw-during-triage",
              type: "unsend",
              source: { type: "group", groupId: "group-a" },
              unsend: { messageId: "pic" },
            },
          ],
        });
        return [decision(["cmd"])];
      }).process("group-a"),
    ).rejects.toThrow("來源訊息已改變");
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
  });
  it("一般聊天、貼圖、圖片與錯誤前綴只顯示，模型與 GitHub 完全不呼叫", async () => {
    for (const [i, text] of [
      "哈囉",
      "請修正按鈕",
      "有人說 /任務 修正",
      "/任務清單",
      " /任務 修正",
    ].entries())
      await receive(`m${i}`, text);
    await receive("sticker", undefined, "sticker");
    await receive("pic", undefined, "image");
    const classify = vi.fn();
    const github = new GitHub();
    const context = vi.spyOn(github, "context");
    await new Triage(
      db,
      { classify },
      github,
      new Line(db),
      new Budget(db),
    ).process("group-a");
    expect(classify).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
    expect(await db.query("SELECT id FROM reservations")).toHaveLength(0);
    expect((await page()).messages).toHaveLength(7);
    expect((await page()).messages.every((m) => m.routing === "chat")).toBe(
      true,
    );
  });
  it("自動辨識模式下 /進度 只顯示、不建任務也不呼叫模型；/進度表 照一般訊息處理", async () => {
    await mode("auto");
    await receive("p1", "/進度");
    await receive("p2", "/進度：看一下");
    const classify = vi.fn<Classifier["classify"]>(async () => []);
    await triage(classify).process("group-a");
    expect(classify).not.toHaveBeenCalled();
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
    const saved = await db.query<{ trigger_mode: string; processed: boolean }>(
      "SELECT trigger_mode,processed FROM messages WHERE id IN ('p1','p2')",
    );
    expect(saved).toEqual([
      { trigger_mode: "chat", processed: true },
      { trigger_mode: "chat", processed: true },
    ]);
    expect((await page()).messages.every((m) => m.routing === "chat")).toBe(
      true,
    );
    // 不是指令的「/進度表」在自動辨識模式下仍是一般待判讀訊息。
    await receive("p3", "/進度表要更新");
    expect(
      await db.one<{ trigger_mode: string; processed: boolean }>(
        "SELECT trigger_mode,processed FROM messages WHERE id='p3'",
      ),
    ).toEqual({ trigger_mode: "auto", processed: false });
  });
  it("簽章收訊、指令引用圖片、去重、辨識、任務與來源 API 串通", async () => {
    await receive("pic", undefined, "image");
    const image = vi.fn(async () => ({
      data: Buffer.from("test-image"),
      mime: "image/png",
    }));
    await downloadPendingImages(db, { image });
    await receive("command", "/任務 把首頁按鈕改成綠色", "text", "pic");
    await receive("command", "/任務 把首頁按鈕改成綠色", "text", "pic");
    const classify = vi.fn<Classifier["classify"]>(async (input) => {
      expect(input.messages.map((m) => m.id).sort()).toEqual([
        "command",
        "pic",
      ]);
      expect(
        input.messages.find((m) => m.id === "pic")?.image?.toString(),
      ).toBe("test-image");
      return [decision(["command"])];
    });
    await triage(classify).process("group-a");
    await triage(classify).process("group-a");
    expect(classify).toHaveBeenCalledTimes(1);
    const rows = (await page()).messages;
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.tasks.length === 1)).toBe(true);
    expect(rows[0].tasks[0].status).toBe("awaiting_approval");
    const detail = (
      await app.inject({ url: `/api/tasks/${rows[0].tasks[0].id}`, headers })
    ).json();
    expect(detail.sources.map((m: { id: string }) => m.id).sort()).toEqual([
      "command",
      "pic",
    ]);
    expect(
      (await app.inject({ url: "/api/messages/pic/image", headers })).body,
    ).toBe("test-image");
  });
  it("切換模式不追溯一般聊天，舊版設定省略模式時保留選擇，重跑遷移亦保留", async () => {
    await receive("old", "把按鈕改成紅色");
    await mode("auto");
    await mode();
    await db.migrate();
    await db.migrate();
    expect(
      (await db.one("SELECT trigger_mode FROM groups WHERE id='group-a'"))
        .trigger_mode,
    ).toBe("auto");
    await receive("new", "把按鈕改成綠色");
    const classify = vi.fn<Classifier["classify"]>(async (input) => {
      expect(input.messages.map((m) => m.id)).toEqual(["new"]);
      return [decision(["new"])];
    });
    await triage(classify).process("group-a");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(
      (await page()).messages.find((m) => m.id === "old")?.tasks,
    ).toHaveLength(0);
  });
  it("辨識途中切換模式再切回，舊結果仍不能派工", async () => {
    await receive("race", "/任務 把按鈕改成綠色");
    await expect(
      triage(async () => {
        await mode("auto");
        await mode("command");
        return [decision(["race"])];
      }).process("group-a"),
    ).rejects.toThrow("群組綁定已更新");
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
    expect((await page()).messages[0].routing).toBe("processed");
  });
  it("引用其他群組或已撤回的圖片時不讀取內容，轉待審核", async () => {
    await receive("foreign", undefined, "image", undefined, "group-b");
    await receive("cross", "/任務 照這張圖改按鈕", "text", "foreign");
    await triage(async (input) => {
      expect(input.messages.map((m) => m.id)).toEqual(["cross"]);
      return [decision(["cross"])];
    }).process("group-a");
    const t = await db.one<{
      status: string;
      missing: string[];
      source_ids: string[];
    }>("SELECT status,missing,source_ids FROM tasks");
    expect(t.status).toBe("awaiting_approval");
    expect(t.missing.join()).toContain("引用");
    expect(t.source_ids).toEqual(["cross"]);
    expect((await page()).messages).toHaveLength(1);
  });
  it("撤回與過期立即遮罩原文、圖片及發話者，即使尚未清理", async () => {
    await receive("gone", "敏感原文", "image");
    await receive("expired", "過期原文", "image");
    await db.query("UPDATE messages SET image=$1,image_mime='image/png'", [
      Buffer.from("image"),
    ]);
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: "unsend",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "gone" },
        },
      ],
    });
    await db.query(
      "UPDATE messages SET received_at=now()-interval '31 days' WHERE id='expired'",
    );
    for (const m of (await page()).messages) {
      expect(m.text).toBeNull();
      expect(m.sender).toBeNull();
      expect(m.has_image).toBe(false);
      expect(
        (await app.inject({ url: `/api/messages/${m.id}/image`, headers }))
          .statusCode,
      ).toBe(404);
    }
  });
  it("發話者顯示 LINE 名稱並快取；不回傳使用者 ID，查不到時退回代號", async () => {
    await receive("named", "你好");
    // 未設定 Token 時不向外查詢，維持群組內代號。
    expect((await page()).messages[0].sender).toMatch(/^成員 [0-9a-f]{6}$/);
    line.token = "fictional-line-token";
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.line.me/v2/bot/group/group-a/member/private-member-id",
      );
      return new Response(JSON.stringify({ displayName: "王小明" }));
    });
    vi.stubGlobal("fetch", fetch);
    const first = await app.inject({
      url: "/api/groups/group-a/messages",
      headers,
    });
    expect(first.json().messages[0].sender).toBe("王小明");
    expect(first.body).not.toContain("private-member-id");
    expect((await page()).messages[0].sender).toBe("王小明");
    expect(fetch).toHaveBeenCalledTimes(1);
    // 成員退出或 LINE 失敗時沿用快取；沒有快取則顯示代號。
    await db.query(
      "UPDATE line_members SET fetched_at=now()-interval '8 days'",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    expect((await page()).messages[0].sender).toBe("王小明");
    await db.query("DELETE FROM line_members");
    expect((await page()).messages[0].sender).toMatch(/^成員 /);
  });
  it("引用訊息顯示內容與發言者；被引用訊息撤回或不在紀錄內時不顯示內容", async () => {
    await receive("origin", "報表要加匯出按鈕");
    await receive("reply", "這個什麼時候好？", "text", "origin");
    await receive("pic", undefined, "image");
    await receive("reply-pic", "照這張", "text", "pic");
    await receive("reply-old", "之前講的那個", "text", "before-bot-joined");
    const find = async (id: string) =>
      (await page()).messages.find((m) => m.id === id)!;
    expect(await find("reply")).toMatchObject({
      quoted_id: "origin",
      quoted_text: "報表要加匯出按鈕",
    });
    expect((await find("reply")).quoted_sender).toMatch(/^成員 [0-9a-f]{6}$/);
    expect((await find("reply-pic")).quoted_text).toBe("圖片");
    expect((await find("reply-old")).quoted_text).toBeNull();
    await db.query(
      "INSERT INTO line_members(group_id,user_id,display_name) VALUES('group-a','private-member-id','王小明')",
    );
    expect((await find("reply")).quoted_sender).toBe("王小明");
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: "unsend-origin",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "origin" },
        },
      ],
    });
    const after = await app.inject({
      url: "/api/groups/group-a/messages",
      headers,
    });
    expect(after.body).not.toContain("報表要加匯出按鈕");
    expect(after.body).not.toContain("private-member-id");
    expect(
      after.json().messages.find((m: { id: string }) => m.id === "reply"),
    ).toMatchObject({ quoted_text: null, quoted_sender: null });
  });
  it("任務來源訊息帶發言者名稱、不回傳使用者 ID；無效的任務連結回報找不到", async () => {
    await receive("src", "/任務 把首頁按鈕改成綠色");
    await triage(async () => [decision(["src"])]).process("group-a");
    const task = await db.one<{ id: string }>("SELECT id FROM tasks");
    const detail = () => app.inject({ url: `/api/tasks/${task.id}`, headers });
    expect((await detail()).json().sources[0].sender).toMatch(
      /^成員 [0-9a-f]{6}$/,
    );
    await db.query(
      "INSERT INTO line_members(group_id,user_id,display_name) VALUES('group-a','private-member-id','王小明')",
    );
    const named = await detail();
    expect(named.json().sources[0].sender).toBe("王小明");
    expect(named.body).not.toContain("private-member-id");
    // 看板動態附上任務名稱。
    const state = (await app.inject({ url: "/api/state", headers })).json();
    expect(
      state.activity.find((a: { task_id: string }) => a.task_id === task.id)
        .task_title,
    ).toBe("調整按鈕顏色");
    const bad = await app.inject({ url: "/api/tasks/abc", headers });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error).toContain("找不到任務");
  });
  it("群組名稱同步 LINE；一小時內不重查，聊天室與失敗時保留原名", async () => {
    const { syncGroupNames } = await import("../server/line-groups.js");
    await receive("g1", "你好", "text", undefined, "Cline-group");
    await receive("r1", "你好", "text", undefined, "Rline-room");
    const name = async (id: string) =>
      (
        await db.one<{ name: string }>("SELECT name FROM groups WHERE id=$1", [
          id,
        ])
      ).name;
    const original = await name("Cline-group");
    // 未設定 Token 時不查詢。
    await syncGroupNames(db);
    expect(await name("Cline-group")).toBe(original);
    line.token = "fictional-line-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await syncGroupNames(db);
    expect(await name("Cline-group")).toBe(original);
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.line.me/v2/bot/group/Cline-group/summary");
      return new Response(JSON.stringify({ groupName: "產線 IT 小組" }));
    });
    vi.stubGlobal("fetch", fetch);
    await syncGroupNames(db);
    expect(await name("Cline-group")).toBe("產線 IT 小組");
    expect(await name("Rline-room")).not.toBe("產線 IT 小組");
    await syncGroupNames(db);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("管理者可修改 AI 記住的群組記憶，修改後改為管理者來源", async () => {
    const m = await db.one<{ id: string }>(
      "INSERT INTO group_memories(group_id,project_id,content,source) VALUES('group-a',NULL,'報表都改報表系統','ai') RETURNING id",
    );
    const put = (payload: object, id = m.id) =>
      app.inject({
        method: "PUT",
        url: `/api/memories/${id}`,
        headers,
        payload,
      });
    const r = await put({
      content: "報表相關需求改這個專案",
      project_id: project,
    });
    expect(r.statusCode).toBe(200);
    expect(
      await db.one("SELECT content,project_id,source FROM group_memories"),
    ).toEqual({
      content: "報表相關需求改這個專案",
      project_id: project,
      source: "admin",
    });
    const unbound = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo) VALUES('未綁定','test/unbound') RETURNING id",
    );
    expect(
      (await put({ content: "改別的", project_id: unbound.id })).statusCode,
    ).toBe(409);
    expect(
      (await put({ content: "不存在", project_id: null }, crypto.randomUUID()))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/memories/${m.id}`,
          payload: { content: "未登入", project_id: null },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("訊息到期清除發話者後，成員名稱快取一併刪除", async () => {
    await receive("old-name", "舊訊息");
    await db.query(
      "INSERT INTO line_members(group_id,user_id,display_name) VALUES('group-a','private-member-id','王小明')",
    );
    await db.query(
      "UPDATE messages SET received_at=now()-interval '31 days' WHERE id='old-name'",
    );
    const { cleanup } = await import("../server/maintenance.js");
    await cleanup(db);
    expect(await db.query("SELECT 1 FROM line_members")).toHaveLength(0);
  });
  it("停用派工或全域暫停仍下載圖片；下載失敗只重試三次", async () => {
    await mode("command", { enabled: false });
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
    );
    await receive("download", undefined, "image");
    const image = vi.fn(async () => {
      throw Error("無法連線");
    });
    for (let i = 0; i < 4; i++) await downloadPendingImages(db, { image });
    expect(image).toHaveBeenCalledTimes(3);
    expect((await page()).messages[0].image_state).toBe("failed");
  });
  it("同時間大量訊息的分頁不重複、不漏訊息，也不接受跨群組游標", async () => {
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,received_at) SELECT 'page-'||lpad(i::text,3,'0'),'group-a','text','測試',now() FROM generate_series(1,105) i",
    );
    await receive("foreign", "另一群", "text", undefined, "group-b");
    const ids: string[] = [];
    let next: string | null = null;
    do {
      const p = await page(next ?? undefined);
      ids.push(...p.messages.map((m) => m.id));
      next = p.next;
    } while (next);
    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect(
      (
        await app.inject({
          url: "/api/groups/group-a/messages?before=foreign",
          headers,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("未登入與非管理者看不到聊天室及圖片，也不能變更觸發模式", async () => {
    expect(
      (await app.inject({ url: "/api/groups/group-a/messages" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/messages/picture/image" })).statusCode,
    ).toBe(401);
    await db.query("UPDATE sessions SET user_id='not-admin'");
    expect((await mode("auto")).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/groups/group-a/messages", headers }))
        .statusCode,
    ).toBe(401);
  });
  it("自動辨識的閒聊貼圖不產生待審核工作；新加入群組預設指令且停用", async () => {
    await mode("auto");
    await receive("sticker", undefined, "sticker");
    await triage(async () => [decision(["sticker"], "ignore")]).process(
      "group-a",
    );
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
    await receive("joined", "/任務 修改按鈕", "text", undefined, "group-new");
    expect(
      await db.one(
        "SELECT enabled,trigger_mode FROM groups WHERE id='group-new'",
      ),
    ).toEqual({ enabled: false, trigger_mode: "command" });
  });
});

describe("聊天室與任務詳情顯示機器人的群組訊息與送達狀態", () => {
  const botNotice = (
    key: string,
    text: string,
    extra: {
      group?: string;
      kind?: string;
      sent?: boolean;
      messageId?: string;
      attempts?: number;
      error?: string;
      age?: string;
    } = {},
  ) =>
    db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,group_id,sent_at,sent_message_id,attempts,last_error,created_at)
       VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END,$6,$7,$8,now()-$9::interval)`,
      [
        extra.kind ?? "group_check",
        key,
        text,
        extra.group ?? "group-a",
        extra.sent ?? false,
        extra.messageId ?? null,
        extra.attempts ?? 0,
        extra.error ?? null,
        extra.age ?? "0 seconds",
      ],
    );

  it("只顯示本群組的機器人訊息與送達狀態；到期文字為空；不回傳 LINE 訊息 ID 與原始錯誤", async () => {
    await receive("other", "別群的訊息", "text", undefined, "group-b");
    await botNotice("sent", "查詢結果：首頁按鈕是綠色", {
      kind: "group_answered",
      sent: true,
      messageId: "fictional-line-message-1",
      attempts: 1,
      age: "2 minutes",
    });
    // 判讀回報之類沒有任務的群組通知也要出現。
    await botNotice("failed", "定期檢查：網站沒有回應", {
      attempts: 3,
      error: "LINE 通知失敗（500）",
      age: "1 minute",
    });
    await botNotice("old", "很久以前的機器人回覆", {
      sent: true,
      age: "31 days",
    });
    await botNotice("foreign", "別群組的機器人回覆", { group: "group-b" });
    await db.query(
      "INSERT INTO notifications(kind,dedupe_key,text) VALUES('approval','direct','管理者私訊內容')",
    );
    await receive("hello", "大家好");
    const r = await app.inject({
      url: "/api/groups/group-a/messages",
      headers,
    });
    const body: ChatPage = r.json();
    expect(body.messages.map((m) => m.id)).toEqual(["hello"]);
    expect(
      body.bot_messages.map((b) => [b.kind, b.task_id, b.text, b.delivery]),
    ).toEqual([
      // 超過保留期限：仍列出時間與狀態，文字回 null。
      [
        "group_check",
        null,
        null,
        { status: "sent", reason: null, note: "已送到群組" },
      ],
      [
        "group_answered",
        null,
        "查詢結果：首頁按鈕是綠色",
        { status: "sent", reason: null, note: "已送到群組" },
      ],
      [
        "group_check",
        null,
        "定期檢查：網站沒有回應",
        { status: "failed", reason: "error", note: "LINE 回應錯誤（500）" },
      ],
    ]);
    expect(r.body).not.toContain("fictional-line-message-1");
    expect(r.body).not.toContain("sent_message_id");
    expect(r.body).not.toContain("last_error");
    expect(r.body).not.toContain("LINE 通知失敗");
    expect(r.body).not.toContain("別群組的機器人回覆");
    expect(r.body).not.toContain("管理者私訊內容");
    expect(r.body).not.toContain("很久以前的機器人回覆");
  });

  it("成員引用機器人訊息時帶出機器人文字；機器人訊息到期後不再帶出", async () => {
    await botNotice("answer", "查詢結果：報表每天早上八點產生", {
      kind: "group_answered",
      sent: true,
      messageId: "fictional-line-message-2",
      attempts: 1,
    });
    // 別群組同一個 LINE 訊息 ID 的通知不能被對到。
    await receive("other", "別群的訊息", "text", undefined, "group-b");
    await botNotice("foreign", "別群組的回答", {
      group: "group-b",
      sent: true,
      messageId: "fictional-line-message-3",
    });
    await receive(
      "ask",
      "那週末也會產生嗎？",
      "text",
      "fictional-line-message-2",
    );
    await receive("cross", "這是哪一則？", "text", "fictional-line-message-3");
    const p = await page();
    const ask = p.messages.find((m) => m.id === "ask")!;
    expect(ask).toMatchObject({
      quoted_text: "查詢結果：報表每天早上八點產生",
      quoted_sender: "機器人",
      quoted_bot_id: p.bot_messages[0].id,
    });
    expect(p.messages.find((m) => m.id === "cross")).toMatchObject({
      quoted_text: null,
      quoted_sender: null,
      quoted_bot_id: null,
    });
    await db.query(
      "UPDATE notifications SET created_at=now()-interval '31 days' WHERE dedupe_key='answer'",
    );
    const expired = await page();
    expect(expired.messages.find((m) => m.id === "ask")).toMatchObject({
      quoted_text: null,
      quoted_sender: null,
    });
    expect(JSON.stringify(expired)).not.toContain("報表每天早上八點產生");
  });

  it("機器人訊息跟著成員訊息分頁，跨頁不重複也不遺漏（含與分頁界線同一時間的訊息）", async () => {
    // 同一個陳述式內 now() 相同：成員訊息每分鐘一則，機器人訊息一則與成員訊息同時、一則晚 30 秒；
    // i=0 比所有成員訊息新，i=106 比所有成員訊息舊。
    await db.query(
      `WITH m AS (
         INSERT INTO messages(id,group_id,type,text,received_at)
         SELECT 'pm-'||lpad(i::text,3,'0'),'group-a','text','測試',now()-make_interval(mins=>i)
         FROM generate_series(1,105) i RETURNING id)
       INSERT INTO notifications(kind,dedupe_key,text,group_id,sent_at,created_at)
       SELECT 'group_check','bot:'||i||':'||x,'機器人 '||i||':'||x,'group-a',now(),
         now()-make_interval(mins=>i)+make_interval(secs=>x*30)
       FROM generate_series(0,106) i,generate_series(0,1) x`,
    );
    await botNotice("foreign", "別群組", { group: "group-b" });
    const bots: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const p = await page(next ?? undefined);
      bots.push(...p.bot_messages.map((b) => b.text!));
      next = p.next;
      pages++;
    } while (next);
    expect(pages).toBe(3);
    expect(bots).toHaveLength(214);
    expect(new Set(bots).size).toBe(214);
    expect(bots).not.toContain("別群組");
  });

  it("一段時間內機器人訊息超過一頁上限時縮短成員訊息頁，較舊的機器人訊息落到下一頁而不是被丟掉", async () => {
    // 成員 10 則、每 10 分鐘一則；機器人 300 則、每 20 秒一則（橫跨約 100 分鐘）。
    await db.query(
      `WITH m AS (
         INSERT INTO messages(id,group_id,type,text,received_at)
         SELECT 'ov-'||lpad(i::text,2,'0'),'group-a','text','測試',now()-make_interval(mins=>i*10)
         FROM generate_series(1,10) i RETURNING id)
       INSERT INTO notifications(kind,dedupe_key,text,group_id,sent_at,created_at)
       SELECT 'group_check','ov:'||j,'機器人 '||j,'group-a',now(),now()-make_interval(secs=>j*20)
       FROM generate_series(0,299) j`,
    );
    const members: string[] = [];
    const bots: string[] = [];
    const sizes: number[] = [];
    let next: string | null = null;
    do {
      const p = await page(next ?? undefined);
      members.push(...p.messages.map((m) => m.id));
      bots.push(...p.bot_messages.map((b) => b.text!));
      sizes.push(p.bot_messages.length);
      next = p.next;
    } while (next);
    // 第 200 新的機器人訊息約在 66 分鐘前：第一頁只留 60 分鐘內的 6 則成員訊息。
    expect(sizes).toEqual([181, 119]);
    expect(new Set(members).size).toBe(10);
    expect(new Set(bots).size).toBe(300);
  });

  it("推播額度用完時任務詳情標示群組訊息沒送出；總開關關閉後改為略過", async () => {
    await db.query("DELETE FROM service_health WHERE name='line_quota'");
    try {
      await receive("src", "/任務 查首頁按鈕顏色");
      await triage(async () => [decision(["src"])]).process("group-a");
      const task = await db.one<{ id: string }>("SELECT id FROM tasks");
      // 只留這則群組回答：撞到每月上限後本輪就停，排在前面的其他通知會先吃掉那次 429。
      await db.query("DELETE FROM notifications");
      await notifyGroup(
        db,
        task.id,
        "answered",
        `answered:${task.id}`,
        "查詢結果：首頁按鈕目前是綠色",
      );
      line.token = "fictional-line-token";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.endsWith("/v2/bot/message/push")
            ? Response.json(
                { message: "You have reached your monthly limit." },
                { status: 429 },
              )
            : Response.json({}),
        ),
      );
      await new Line(db).flushNotifications();
      const detail = async () => {
        const r = await app.inject({ url: `/api/tasks/${task.id}`, headers });
        expect(r.statusCode).toBe(200);
        return {
          body: r.body,
          answered: (
            r.json().groupDeliveries as {
              kind: string;
              text: string;
              delivery: { status: string; reason: string | null };
            }[]
          ).find((d) => d.kind === "group_answered")!,
        };
      };
      const blocked = await detail();
      expect(blocked.answered).toMatchObject({
        text: "查詢結果：首頁按鈕目前是綠色",
        delivery: {
          status: "pending",
          reason: "quota",
          note: "LINE 本月推播額度已用完",
        },
      });
      // 原始 last_error（含「下個月初重置」）不送給瀏覽器。
      expect(blocked.body).not.toContain("下個月初重置");
      expect(blocked.body).not.toContain('last_error":"LINE');

      await db.query(
        "UPDATE settings SET value=value||'{\"group_replies\":false}'::jsonb",
      );
      await new Line(db).flushNotifications();
      expect((await detail()).answered.delivery).toMatchObject({
        status: "skipped",
        reason: "replies_off",
      });
    } finally {
      await db.query("DELETE FROM service_health WHERE name='line_quota'");
    }
  });
});
