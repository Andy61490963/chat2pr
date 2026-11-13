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
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
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
    await db.query("UPDATE line_members SET fetched_at=now()-interval '8 days'");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
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
      (await db.one<{ name: string }>("SELECT name FROM groups WHERE id=$1", [id]))
        .name;
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
      app.inject({ method: "PUT", url: `/api/memories/${id}`, headers, payload });
    const r = await put({ content: "報表相關需求改這個專案", project_id: project });
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
    expect((await put({ content: "改別的", project_id: unbound.id })).statusCode).toBe(409);
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
