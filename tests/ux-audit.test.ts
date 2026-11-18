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
    lineSecret: "fictional-secret",
    lineToken: "fictional-token",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { announceNewGroups } from "../server/line-groups.js";
import { recordHealth } from "../server/health.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  await db.query("DELETE FROM service_health");
  app = await buildApp(db);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await app.close();
});
afterAll(() => db.close());

const lineEvent = (event: object) => {
  const body = JSON.stringify({ events: [event] });
  return app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-secret")
        .update(body)
        .digest("base64"),
    },
  });
};
const notices = (kind: string) =>
  db.query<{ text: string; task_id: string | null }>(
    "SELECT text,task_id FROM notifications WHERE kind=$1 ORDER BY created_at",
    [kind],
  );
const group = (id = "group-a") =>
  db.one<{ enabled: boolean; left_at: Date | null }>(
    "SELECT enabled,left_at FROM groups WHERE id=$1",
    [id],
  );
const state = async (query = "") =>
  (
    await app.inject({ url: `/api/state${query}`, headers: await session() })
  ).json();
const pair = () =>
  db.query(
    'UPDATE settings SET value=value||\'{"admin_line_id":"fictional-admin"}\'',
  );
const task = (status: string, key: string) =>
  db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,title,summary,status,dedupe_key) VALUES('group-a','任務','內容',$1,$2) RETURNING id",
    [status, key],
  );
const act = async (id: string, action: string, version: number) =>
  app.inject({
    method: "POST",
    url: `/api/tasks/${id}/actions`,
    headers: await session(),
    payload: { action, version },
  });

describe("機器人離開與加入群組", () => {
  it("被移出群組時標記離開、停用並通知；重複事件不重複通知", async () => {
    await fixture();
    const leave = {
      webhookEventId: "leave-1",
      type: "leave",
      source: { type: "group", groupId: "group-a" },
    };
    expect((await lineEvent(leave)).statusCode).toBe(200);
    await lineEvent(leave);
    await lineEvent({ ...leave, webhookEventId: "leave-2" });
    const g = await group();
    expect(g?.enabled).toBe(false);
    expect(g?.left_at).not.toBeNull();
    const sent = await notices("group_left");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("測試群組");
    const listed = (await state()).groups.find(
      (x: { id: string }) => x.id === "group-a",
    );
    expect(listed.left_at).toBeTruthy();
  });

  it("沒見過的群組傳來離開事件，不建立群組也不通知", async () => {
    await lineEvent({
      webhookEventId: "leave-unknown",
      type: "leave",
      source: { type: "group", groupId: "group-unknown" },
    });
    expect(await db.query("SELECT 1 FROM groups")).toHaveLength(0);
    expect(await notices("group_left")).toHaveLength(0);
  });

  it("離開期間不能啟用；機器人回來後維持停用並通知，之後才可啟用", async () => {
    const projectId = await fixture();
    await lineEvent({
      webhookEventId: "leave-1",
      type: "leave",
      source: { type: "group", groupId: "group-a" },
    });
    const enable = async () =>
      app.inject({
        method: "PUT",
        url: "/api/groups/group-a",
        headers: await session(),
        payload: { name: "測試群組", project_ids: [projectId], enabled: true },
      });
    const refused = await enable();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("機器人已離開");
    await lineEvent({
      webhookEventId: "join-1",
      type: "join",
      source: { type: "group", groupId: "group-a" },
    });
    const g = await group();
    expect(g?.left_at).toBeNull();
    expect(g?.enabled).toBe(false);
    const back = await notices("group_new");
    expect(back).toHaveLength(1);
    expect(back[0].text).toContain("回到群組「測試群組」");
    expect((await enable()).statusCode).toBe(200);
    expect((await group())?.enabled).toBe(true);
  });

  it("新群組通知一次：名稱同步後或兩分鐘後才通知，已啟用與已離開的不通知", async () => {
    await db.query(
      `INSERT INTO groups(id,name,enabled,name_synced_at,created_at,left_at) VALUES
        ('g-synced','已同步',false,now(),now(),NULL),
        ('g-fresh','剛加入',false,NULL,now(),NULL),
        ('g-old','沒名稱',false,NULL,now()-interval '3 minutes',NULL),
        ('g-enabled','已啟用',true,now(),now(),NULL),
        ('g-left','已離開',false,now(),now(),now())`,
    );
    await announceNewGroups(db);
    await announceNewGroups(db);
    const texts = (await notices("group_new")).map((n) => n.text);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("「已同步」"))).toBe(true);
    expect(texts.some((t) => t.includes("「沒名稱」"))).toBe(true);
    await db.query("UPDATE groups SET name_synced_at=now() WHERE id='g-fresh'");
    await announceNewGroups(db);
    expect(await notices("group_new")).toHaveLength(3);
  });
});

describe("服務狀態通知", () => {
  it("第一次觀察只建立基準；正常轉異常、異常恢復各通知一次", async () => {
    await recordHealth(db, "github", true, "正常");
    expect(await db.query("SELECT 1 FROM notifications")).toHaveLength(0);
    await recordHealth(db, "github", false, "GitHub App 驗證失敗");
    await recordHealth(db, "github", false, "GitHub App 驗證失敗");
    const down = await notices("service_down");
    expect(down).toHaveLength(1);
    expect(down[0].text).toContain("GitHub App");
    await recordHealth(db, "github", true, "正常");
    await recordHealth(db, "github", true, "正常");
    expect(await notices("service_up")).toHaveLength(1);
    const health = (await state()).health.find(
      (h: { name: string }) => h.name === "github",
    );
    expect(health.ok).toBe(true);
  });

  it("一開始就異常的服務不通知；非關鍵服務不通知", async () => {
    await recordHealth(db, "runner", false, "無法連線");
    await recordHealth(db, "runner", false, "無法連線");
    await recordHealth(db, "embedder", true, "正常");
    await recordHealth(db, "embedder", false, "模型載入失敗");
    expect(await db.query("SELECT 1 FROM notifications")).toHaveLength(0);
  });

  it("需要確認的項目轉異常與恢復都要連續兩次才通知，瞬斷與瞬間恢復都不通知", async () => {
    const tunnel = (ok: boolean) =>
      recordHealth(db, "tunnel", ok, ok ? "正常" : "無法連線", {
        confirm: true,
      });
    await tunnel(true);
    await tunnel(false);
    await tunnel(true);
    expect(await db.query("SELECT 1 FROM notifications")).toHaveLength(0);
    await tunnel(false);
    await tunnel(false);
    expect(await notices("service_down")).toHaveLength(1);
    await tunnel(true);
    await tunnel(false);
    expect(await notices("service_up")).toHaveLength(0);
    await tunnel(true);
    await tunnel(true);
    expect(await notices("service_up")).toHaveLength(1);
    expect(await notices("service_down")).toHaveLength(1);
  });
});

describe("重新開啟任務", () => {
  it("已拒絕與已取消的任務可重新開啟，回到待審核並成為新版本", async () => {
    await fixture();
    for (const status of ["rejected", "cancelled"]) {
      const t = await task(status, `reopen-${status}`);
      const response = await act(t.id, "reopen", 1);
      expect(response.statusCode).toBe(200);
      const row = await db.one<{
        status: string;
        version: number;
        approved_version: number | null;
      }>("SELECT status,version,approved_version FROM tasks WHERE id=$1", [
        t.id,
      ]);
      expect(row).toEqual({
        status: "awaiting_approval",
        version: 2,
        approved_version: null,
      });
    }
  });

  it("其他狀態不能重新開啟，舊版本也不能", async () => {
    await fixture();
    for (const status of ["merged", "ready", "closed", "queued"]) {
      const t = await task(status, `no-reopen-${status}`);
      expect((await act(t.id, "reopen", 1)).statusCode).toBe(409);
    }
    const t = await task("rejected", "stale-reopen");
    expect((await act(t.id, "reopen", 5)).statusCode).toBe(409);
    expect(
      (
        await db.one<{ status: string }>(
          "SELECT status FROM tasks WHERE id=$1",
          [t.id],
        )
      )?.status,
    ).toBe("rejected");
  });
});

describe("清單筆數與失敗通知", () => {
  it("群組儲存警告包含未載入清單的受影響任務", async () => {
    await fixture();
    const pending = await task("queued", "outside-loaded-tasks");
    await db.query(
      "UPDATE tasks SET updated_at=now()-interval '1 day' WHERE id=$1",
      [pending.id],
    );
    await task("merged", "latest-task");
    const limited = await state("?tasks=1");
    expect(limited.tasks).toHaveLength(1);
    expect(limited.tasks[0].id).not.toBe(pending.id);
    expect(
      limited.groups.find((g: { id: string }) => g.id === "group-a")
        .affected_tasks,
    ).toBe(1);
  });

  it("狀態回報總筆數，並可用參數載入更多", async () => {
    await fixture();
    for (let n = 0; n < 3; n++) await task("merged", `total-${n}`);
    for (let n = 0; n < 3; n++) await db.audit(null, "test", `動態 ${n}`);
    const limited = await state("?tasks=2&activity=1");
    expect(limited.tasks).toHaveLength(2);
    expect(limited.activity).toHaveLength(1);
    expect(limited.totals.tasks).toBe(3);
    expect(limited.totals.activity).toBeGreaterThanOrEqual(3);
    const all = await state("?tasks=abc");
    expect(all.tasks).toHaveLength(3);
  });

  it("送不出去的通知會計數；重送後歸零重新排入", async () => {
    await db.query(
      "INSERT INTO notifications(kind,dedupe_key,text,attempts,last_error) VALUES('failed','a','甲',3,'LINE 通知失敗（401）'),('failed','b','乙',1,NULL)",
    );
    expect((await state()).failedNotifications).toBe(1);
    const retried = await app.inject({
      method: "POST",
      url: "/api/notifications/retry",
      headers: await session(),
    });
    expect(retried.statusCode).toBe(200);
    expect((await state()).failedNotifications).toBe(0);
  });
});

const blockQuota = () =>
  recordHealth(
    db,
    "line_quota",
    false,
    "LINE 本月推播額度已用完，下個月初重置；群組的『收到』與看板鈴鐺不受影響（本月已用 200／上限 200 則）",
  );
// reset() 不清 service_health；留著 line_quota 會讓之後其他測試檔的推播全部暫停。
const clearQuota = () =>
  db.query("DELETE FROM service_health WHERE name='line_quota'");

describe("LINE 推播額度與重送", () => {
  const retry = async () =>
    app.inject({
      method: "POST",
      url: "/api/notifications/retry",
      headers: await session(),
    });
  afterEach(clearQuota);

  /** 還有效與過時的群組通知、私訊各一則都重試 3 次失敗；另一則私訊還在自動重試。 */
  const failures = async () => {
    await fixture();
    const answered = await task("answered", "quota-answered");
    const waiting = await task("queued", "quota-waiting");
    await db.query(
      `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,attempts,last_error,created_at) VALUES
        ($1,'group_answered','r1','查詢結果','group-a',3,'LINE 通知失敗（500）',now()-interval '1 hour'),
        ($2,'group_waiting','r2','排在第 2 位','group-a',3,'LINE 通知失敗（500）',now()-interval '7 hours')`,
      [answered.id, waiting.id],
    );
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,attempts,last_error,created_at) VALUES
        ('service_down','r3','服務異常',3,'LINE 通知失敗（500）',now()-interval '2 hours'),
        ('service_down','r4','服務異常二',1,'LINE 通知失敗（500）',now())`,
    );
  };

  it("狀態把送不出去的通知分成私訊、群組與重送時會略過的過期通知", async () => {
    await failures();
    const s = await state();
    expect(s.notificationFailures).toEqual({ direct: 1, group: 1, stale: 1 });
    expect(s.failedNotifications).toBe(2);
  });

  it("額度用完時拒絕重送並說明，不歸零任何通知", async () => {
    await failures();
    await blockQuota();
    const response = await retry();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(
      "LINE 本月推播額度已用完，額度恢復前重送也會失敗",
    );
    expect(
      await db.query("SELECT 1 FROM notifications WHERE attempts=0"),
    ).toHaveLength(0);
  });

  it("重送先略過過期通知，只重排重試 3 次仍失敗的；還在自動重試的不受影響", async () => {
    await failures();
    const response = await retry();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ direct: 1, group: 1, expired: 1 });
    const rows = await db.query<{
      dedupe_key: string;
      attempts: number;
      sent_at: Date | null;
      last_error: string | null;
    }>(
      "SELECT dedupe_key,attempts,sent_at,last_error FROM notifications WHERE dedupe_key LIKE 'r_' ORDER BY dedupe_key",
    );
    expect(rows.map((r) => [r.dedupe_key, r.attempts, r.last_error])).toEqual([
      ["r1", 0, null],
      ["r2", 3, "已過期，未補送"],
      ["r3", 0, null],
      ["r4", 1, "LINE 通知失敗（500）"],
    ]);
    expect(rows[1].sent_at).not.toBeNull();
    const [audit] = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='notification_retry'",
    );
    expect(audit.detail).toContain("私訊 1 則、群組 1 則，略過已過期 1 則");
  });

  it("過期的私訊不逐則補送，改排一則彙整請管理者到看板查看", async () => {
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,attempts,created_at) VALUES
        ('service_down','old-1','舊通知一',3,now()-interval '3 days'),
        ('service_down','old-2','舊通知二',3,now()-interval '2 days')`,
    );
    expect((await retry()).json()).toEqual({
      direct: 0,
      group: 0,
      expired: 2,
    });
    const backlog = await notices("line_backlog");
    expect(backlog).toHaveLength(1);
    expect(backlog[0].text).toContain("有 2 則通知");
    expect(backlog[0].text).toContain("看板鈴鐺");
  });

  it("額度用完時鈴鐺清單頂端多一行提示；恢復後消失", async () => {
    await blockQuota();
    const alerts = (await state()).alerts;
    expect(alerts[0]).toMatchObject({
      kind: "line_quota",
      text: "LINE 推播額度用完，群組回覆與私訊暫停，看板通知照常",
    });
    await recordHealth(db, "line_quota", true, "本月已用 3／上限 200 則");
    expect(
      (await state()).alerts.some(
        (a: { kind: string }) => a.kind === "line_quota",
      ),
    ).toBe(false);
  });
});

describe("測試通知", () => {
  const send = async () =>
    app.inject({
      method: "POST",
      url: "/api/notifications/test",
      headers: await session(),
    });

  it("尚未配對時說明要先配對，不呼叫 LINE", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("請先完成 LINE 配對");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("已配對時私訊管理者一則測試通知", async () => {
    await pair();
    const upstream = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", upstream);
    expect((await send()).statusCode).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe("fictional-admin");
    expect(body.messages[0].text).toContain("測試通知");
  });

  it("LINE 拒收時回報可以照著處理的原因", async () => {
    await pair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("LINE 沒有收下測試通知（401）");
  });

  it("額度用完時不推播，說明是額度問題、權杖沒有問題", async () => {
    await pair();
    await blockQuota();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("LINE 本月推播額度已用完，權杖沒有問題");
    expect(upstream).not.toHaveBeenCalled();
    await clearQuota();
  });

  it("推播回每月上限時同樣說明，並記下額度用完", async () => {
    await pair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "You have reached your monthly limit." },
          { status: 429 },
        ),
      ),
    );
    const response = await send();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("LINE 本月推播額度已用完，權杖沒有問題");
    const quota = (await state()).health.find(
      (h: { name: string }) => h.name === "line_quota",
    );
    expect(quota.ok).toBe(false);
    await clearQuota();
  });
});

describe("LINE 通知連結", () => {
  it("沒有任務的通知連到能處理它的頁面", async () => {
    await pair();
    const texts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        texts.push(JSON.parse(String(init.body)).messages[0].text);
        return new Response("{}");
      }),
    );
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,created_at) VALUES
        ('group_left','k1','群組通知',now()-interval '4 seconds'),
        ('triage','k2','辨識通知',now()-interval '3 seconds'),
        ('service_down','k3','服務通知',now()-interval '2 seconds'),
        ('repo_missing','k4','儲存庫通知',now()-interval '1 second')`,
    );
    await new Line(db).flushNotifications();
    const base = "http://localhost:4310";
    expect(texts).toEqual([
      `群組通知\n${base}/groups`,
      `辨識通知\n${base}/groups`,
      `服務通知\n${base}/settings`,
      `儲存庫通知\n${base}/projects`,
    ]);
    const health = (await state()).health.find(
      (h: { name: string }) => h.name === "notifications",
    );
    expect(health.ok).toBe(true);
  });
});

describe("複查後的修正", () => {
  it("一小時內異常、恢復、再異常，每次轉換都通知", async () => {
    await recordHealth(db, "github", true, "正常");
    await recordHealth(db, "github", false, "驗證失敗");
    await recordHealth(db, "github", true, "正常");
    await recordHealth(db, "github", false, "驗證失敗");
    expect(await notices("service_down")).toHaveLength(2);
    expect(await notices("service_up")).toHaveLength(1);
    await recordHealth(db, "github", true, "正常");
    expect(await notices("service_up")).toHaveLength(2);
  });

  it("沒有記錄分支的舊任務重新開啟或再查一次時，帶入專案預設分支並待確認", async () => {
    const project = await fixture();
    const old = async (status: string, key: string) => {
      const t = await task(status, key);
      await db.query(
        "UPDATE tasks SET project_id=$2,mode='query' WHERE id=$1",
        [t.id, project],
      );
      await db.query("UPDATE tasks SET target_branch=NULL WHERE id=$1", [t.id]);
      return t;
    };
    const branch = (id: string) =>
      db.one<{
        target_branch: string | null;
        status: string;
        basis: string | null;
        reason: string | null;
      }>(
        "SELECT target_branch,status,branch_selection->>'basis' AS basis,branch_selection->>'reason' AS reason FROM tasks WHERE id=$1",
        [id],
      );
    const amend = async (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/tasks/${id}/actions`,
        headers: await session(),
        payload: {
          action: "amend",
          version: 1,
          summary: "換個條件再查一次",
          acceptance: ["列出結果"],
        },
      });
    const cancelled = await old("cancelled", "old-cancelled");
    expect((await act(cancelled.id, "reopen", 1)).statusCode).toBe(200);
    expect(await branch(cancelled.id)).toEqual({
      target_branch: "main",
      status: "awaiting_approval",
      basis: "uncertain",
      reason: expect.stringContaining("專案預設分支"),
    });
    const answered = await old("answered", "old-answered");
    expect((await amend(answered.id)).statusCode).toBe(200);
    expect(await branch(answered.id)).toMatchObject({
      target_branch: "main",
      basis: "uncertain",
    });
    // 待審核中分支消失的任務：補充需求不會自動改用預設分支，仍要由人選。
    const waiting = await old("awaiting_approval", "branch-gone");
    expect((await amend(waiting.id)).statusCode).toBe(200);
    expect((await branch(waiting.id))?.target_branch).toBeNull();
  });
});
