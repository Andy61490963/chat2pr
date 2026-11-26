import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushLinePrivate,
  privateActionKinds,
  privateDigestText,
} from "../server/line-private.js";
import {
  linePrivateDefaults,
  linePrivateQuotaHold,
} from "../shared/line-private.js";
import { linePushPanel } from "../shared/line-quota.js";
import { db, reset } from "./helpers.js";

describe("LINE 私訊摘要的送出時機", () => {
  const start = new Date("2026-11-21T01:00:00Z").getTime();
  const push = vi.fn<typeof fetch>();

  function setMinute(minute: number) {
    vi.setSystemTime(start + minute * 60_000);
  }

  async function enqueue(kind: string, text: string) {
    await db.query(
      "INSERT INTO notifications(kind,dedupe_key,text,created_at) VALUES($1,$2,$2,$3)",
      [kind, text, new Date()],
    );
  }

  function pushedText(index: number): string {
    const body = JSON.parse(String(push.mock.calls[index][1]?.body));
    return body.messages[0].text;
  }

  beforeEach(async () => {
    await reset();
    await db.query(
      "UPDATE settings SET value=value || '{\"admin_line_id\":\"U-demo\",\"line_group_reserve_percent\":0}'::jsonb WHERE id=1",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    setMinute(0);
    push.mockReset().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", push);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await db.query("DELETE FROM service_health WHERE name='line_quota'");
  });

  it.each([
    { used: 159, includeNewGroup: true },
    { used: 160, includeNewGroup: false },
  ])("全通知私訊在已用 $used／200 時按重要性使用剩餘額度", async ({ used, includeNewGroup }) => {
    await db.query("UPDATE settings SET value=value || '{\"line_private_mode\":\"all\"}'::jsonb WHERE id=1");
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,$1) ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail",
      [`本月已用 ${used}／上限 200 則`],
    );
    await enqueue("failed", "示範任務失敗，需要你處理");
    await enqueue("answered", "示範查詢已有答案");
    await enqueue("ready", "示範修改已建立 PR");
    await enqueue("group_new", "範例群組剛加入");
    await flushLinePrivate(db, "testToken123");
    expect(push).toHaveBeenCalledTimes(1);
    expect(pushedText(0)).toContain("示範任務失敗，需要你處理");
    expect(pushedText(0)).toContain("示範查詢已有答案");
    expect(pushedText(0)).toContain("示範修改已建立 PR");
    expect(pushedText(0).includes("範例群組剛加入")).toBe(includeNewGroup);
  });

  it("低額度的全通知私訊保留定期檢查異常及需排除的系統設定問題", async () => {
    await db.query("UPDATE settings SET value=value || '{\"line_private_mode\":\"all\"}'::jsonb WHERE id=1");
    await db.query(
      "INSERT INTO service_health(name,ok,detail) VALUES('line_quota',true,'本月已用 165／上限 200 則') ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail",
    );
    await db.query(
      `INSERT INTO notifications(kind,dedupe_key,text,created_at) VALUES
       ('check','check:demo:1','⚠️ 示範服務異常',$1),
       ('check','check:demo:2','示範服務已恢復',$1),
       ('check','check-system:demo','定期檢查因系統設定問題暫停執行',$1)`, [new Date()],
    );
    await flushLinePrivate(db, "testToken123");
    expect(push).toHaveBeenCalledTimes(1);
    expect(pushedText(0)).toContain("示範服務異常");
    expect(pushedText(0)).toContain("定期檢查因系統設定問題暫停執行");
    expect(pushedText(0)).not.toContain("示範服務已恢復");
  });

  it("第一件立即送出，第二、三件在上一則送出滿 10 分鐘時合併", async () => {
    await enqueue("approval", "第一件需要你確認");
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(1);
    expect(pushedText(0)).toContain("• 第一件需要你確認");

    setMinute(1);
    await enqueue("failed", "第二件執行失敗");
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(1);

    setMinute(9);
    await enqueue("input_required", "第三件需要補問");
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(1);

    setMinute(10);
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(2);
    expect(pushedText(1)).toBe(
      privateDigestText(
        [{ text: "第二件執行失敗" }, { text: "第三件需要補問" }],
        "http://localhost:4310",
      ),
    );
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("推播失敗時保留批次與重試鍵，成功後才開始計時", async () => {
    push.mockImplementationOnce(async () =>
      Response.json({}, { status: 500 }),
    );
    await enqueue("approval", "範例待確認");
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(1);

    setMinute(2);
    await enqueue("failed", "範例執行失敗");
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][1]?.headers).toEqual(push.mock.calls[0][1]?.headers);
    expect(pushedText(1)).toBe(pushedText(0));

    setMinute(10);
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(2);

    setMinute(12);
    await flushLinePrivate(db, "虛構權杖");
    expect(push).toHaveBeenCalledTimes(3);
    expect(pushedText(2)).toContain("• 範例執行失敗");
  });
});

describe("LINE 私訊摘要", () => {
  it("預設只允許需要動手的通知種類，服務異常另有中斷門檻", () => {
    expect(linePrivateDefaults.line_private_mode).toBe("action");
    expect(privateActionKinds).toEqual(
      expect.arrayContaining(["approval", "failed", "project_input", "connection_secrets_updated"]),
    );
    for (const kind of ["answered", "ready", "service_down", "service_up"])
      expect(privateActionKinds).not.toContain(kind);
  });

  it("一則摘要列出三件事，各取第一行，並附看板連結", () => {
    expect(
      privateDigestText(
        [
          { text: "你有一件要確認" },
          { text: "你有一件失敗要處理\n詳細原因" },
          { text: "你有一件專案補問" },
        ],
        "https://board.example.invalid",
      ),
    ).toBe(
      [
        "你的通知摘要",
        "• 你有一件要確認",
        "• 你有一件失敗要處理",
        "• 你有一件專案補問",
        "",
        "看板：https://board.example.invalid",
      ].join("\n"),
    );
  });

  it("摘要最多列五件，其餘顯示件數", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      text: `範例待辦 ${i + 1}`,
    }));
    const digest = privateDigestText(items, "https://board.example.invalid");
    expect(digest.match(/^• /gm)).toHaveLength(5);
    expect(digest).toContain("另有 2 件，請到看板查看");
    expect(digest).not.toContain("範例待辦 6");
  });

  it("預設保留 70%，到門檻就暫停私訊並顯示原因", () => {
    const reserve = linePrivateDefaults.line_group_reserve_percent;
    expect(linePrivateQuotaHold({ limit: 200, used: 59 }, reserve)).toBeNull();
    expect(linePrivateQuotaHold({ limit: 200, used: 60 }, reserve)).toBe(
      "reserved",
    );
    expect(
      linePrivateQuotaHold({ limit: null, used: 1000 }, reserve),
    ).toBeNull();
    expect(linePrivateQuotaHold({ limit: null, used: 0 }, 100)).toBe(
      "reserved",
    );
    expect(linePrivateQuotaHold({ limit: 3, used: 0 }, reserve)).toBe(
      "reserved",
    );
    expect(
      linePushPanel(
        [{ name: "line_quota", ok: true, detail: "本月已用 60／上限 200 則" }],
        { direct: 0, group: 0, stale: 0 },
      ),
    ).toMatchObject({
      testDisabled: true,
      retryDisabled: false,
      notice: expect.stringContaining("私訊暫停"),
    });
  });

  it("本月用量未知時，保留比例不會暫停私訊或停用測試通知", () => {
    const reserves = [0, linePrivateDefaults.line_group_reserve_percent, 100];
    for (const reserve of reserves) {
      expect(linePrivateQuotaHold(null, reserve)).toBeNull();
      const panel = linePushPanel([], { direct: 0, group: 0, stale: 0 }, reserve);
      expect(panel).toMatchObject({
        usage: null,
        testDisabled: false,
        notice: null,
      });
    }
  });
});
