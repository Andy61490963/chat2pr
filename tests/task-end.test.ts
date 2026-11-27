import { describe, expect, it } from "vitest";
import { taskEndSummary } from "../server/task-end.js";
import type { TaskStatus } from "../shared/types.js";

const at = "2026-11-20T02:30:00.000Z";
const task = {
  status: "cancelled" as TaskStatus,
  updated_at: at,
  pr_number: null,
  approved_version: null,
};
const audit = (kind: string, detail: string) => ({
  kind,
  detail,
  created_at: at,
});

describe("任務結束摘要", () => {
  it.each([
    [
      "拒絕",
      "reject",
      "小林 拒絕（需求版本 1；目標分支 main）",
      "reject",
      "小林",
      null,
      null,
    ],
    [
      "取消",
      "cancel",
      "小林 取消（需求版本 1）：清理範例群組的任務",
      "cancel",
      "小林",
      "清理範例群組的任務",
      null,
    ],
    [
      "關閉 PR",
      "closed",
      "PR #12 已在 GitHub 關閉（定期同步）",
      "closed",
      null,
      null,
      "pr",
    ],
    [
      "其他結束方式",
      "closed",
      "示範專案已刪除，PR 不再追蹤",
      "other",
      null,
      null,
      null,
    ],
  ] as const)(
    "分類並摘錄%s的稽核",
    (_name, kind, detail, expectedKind, actor, reason, station) => {
      expect(taskEndSummary(task, audit(kind, detail))).toEqual({
        kind: expectedKind,
        actor,
        at,
        reason,
        station,
      });
    },
  );

  it("以重複為由取消時保留操作者與結案時間", () => {
    expect(taskEndSummary(
      { ...task, end_reason: "duplicate" },
      audit("cancel", "小林 取消（需求版本 1），原因：重複"),
    )).toEqual({ kind: "duplicate", actor: "小林", at, reason: "重複", station: null });
  });

  it("取出新版取消格式的說明，並依執行階段保留站別", () => {
    expect(
      taskEndSummary(
        task,
        audit(
          "cancel",
          "小林 取消（需求版本 2；目標分支 main），原因：改由小陳處理",
        ),
        "test",
      ),
    ).toMatchObject({
      actor: "小林",
      reason: "改由小陳處理",
      station: "verify",
    });
  });

  it("取出拒絕時選的原因與補充", () => {
    expect(
      taskEndSummary(
        { ...task, status: "rejected" },
        audit(
          "reject",
          "小林 拒絕（需求版本 1；目標分支 待選擇），原因：需求還沒定案；範例群組還在討論",
        ),
      ),
    ).toMatchObject({
      kind: "reject",
      actor: "小林",
      reason: "需求還沒定案；範例群組還在討論",
    });
  });

  it("略過無法辨識的稽核文字與含憑證格式的舊說明", () => {
    expect(
      taskEndSummary(task, audit("cancel", "小林傳來了範例訊息")),
    ).toMatchObject({
      kind: "cancel",
      at,
      actor: null,
      reason: null,
    });
    expect(
      taskEndSummary(
        task,
        audit("cancel", "小林 取消（需求版本 1）：密碼：虛構值"),
      ),
    ).toMatchObject({
      actor: "小林",
      reason: null,
    });
  });

  it("舊任務缺少稽核時沿用已知狀態，重新開啟後清除摘要", () => {
    expect(taskEndSummary(task, null)).toMatchObject({
      kind: "cancel",
      at,
      actor: null,
    });
    expect(
      taskEndSummary(
        { ...task, status: "awaiting_approval" },
        audit("cancel", "小林 取消（需求版本 1）"),
      ),
    ).toBeNull();
  });
});
