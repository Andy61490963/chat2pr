import { describe, expect, it } from "vitest";
import {
  notificationPath,
  notificationTarget,
} from "../shared/notifications.js";
import { dispatchStatus } from "../src/app/dispatch-status.js";

describe("鈴鐺通知按下去會去哪", () => {
  it("有任務的通知開任務，管理者與成員都一樣", () => {
    for (const admin of [true, false])
      expect(
        notificationTarget({ task_id: "task-1", kind: "failed" }, admin),
      ).toEqual({ task: "task-1" });
  });
  it("管理者看到沒有任務的通知時帶去能處理它的頁面", () => {
    expect(
      notificationTarget({ task_id: null, kind: "service_down" }, true),
    ).toEqual({ view: "settings" });
    expect(
      notificationTarget({ task_id: null, kind: "repo_missing" }, true),
    ).toEqual({ view: "projects" });
  });
  it("成員的 service_down 通知不能前往，說明由管理者處理", () => {
    expect(
      notificationTarget({ task_id: null, kind: "service_down" }, false),
    ).toEqual({ note: "由管理者到看板處理" });
  });
  it("沒有頁面可去的通知標成僅供參考", () => {
    for (const admin of [true, false])
      expect(
        notificationTarget({ task_id: null, kind: "knowledge" }, admin),
      ).toEqual({ note: "僅供參考" });
  });
});

describe("頁首派工狀態", () => {
  const cases = [
    { paused: true, triagePaused: false, hold: null, label: "已暫停" },
    { paused: false, triagePaused: false, hold: null, label: "自動派工中" },
    { paused: false, triagePaused: true, hold: null, label: "判讀暫停中" },
    {
      paused: false,
      triagePaused: false,
      hold: "主機記憶體不足，暫停派新工作",
      label: "派工自動暫停",
    },
  ];
  it("成員只看狀態：沒有「點此」，註明切換由管理者在設定處理", () => {
    for (const c of cases) {
      const s = dispatchStatus({ ...c, admin: false });
      expect(s.label).toBe(c.label);
      expect(s.title).toContain("切換由管理者在設定處理");
      expect(JSON.stringify(s)).not.toContain("點此");
      expect(s).not.toHaveProperty("ariaLabel");
    }
  });
  it("管理者照舊是可切換的按鈕", () => {
    for (const c of cases) {
      expect(dispatchStatus({ ...c, admin: true }).ariaLabel).toContain(
        c.label,
      );
    }
    expect(dispatchStatus({ ...cases[0], admin: true })).toMatchObject({
      label: "已暫停",
      ariaLabel: "已暫停，點此開始自動派工",
      title: "目前只接收訊息，不辨識與派工；點此開始",
    });
    expect(dispatchStatus({ ...cases[2], admin: true }).title).toBe(
      "新需求判讀已暫停，已核准任務仍可執行；點此暫停派工",
    );
    expect(dispatchStatus({ ...cases[1], admin: true }).title).toBe(
      "已確認修改與明確查詢會依序派工；點此暫停",
    );
  });
});

it("LINE 私訊與看板使用相同的專案分頁，舊通知找不到專案時開列表", () => {
  expect(
    notificationPath({
      task_id: null,
      kind: "repo_missing",
      project_id: "demo",
    }),
  ).toBe("projects?project=demo&tab=overview");
  expect(
    notificationPath({
      task_id: null,
      kind: "project_input",
      project_id: "demo",
    }),
  ).toBe("projects?project=demo&tab=environment");
  expect(notificationPath({ task_id: null, kind: "project_input" })).toBe(
    "projects",
  );
});
