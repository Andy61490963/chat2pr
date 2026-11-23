import { describe, expect, it } from "vitest";
import {
  heartbeatStale,
  HEARTBEAT_STALE_MS,
  runProgress,
} from "../shared/run-progress.js";
import {
  countStatuses,
  statusLabels,
  taskGroups,
  unfinishedStatuses,
  type TaskStatus,
} from "../shared/types.js";

// 看板任務列與任務詳情標頭的一行進度（src/app/shared.tsx 的 RunProgressLine 用它）。
describe("runProgress：進行中顯示階段與已跑時間", () => {
  const now = Date.parse("2026-11-18T06:20:00Z"); // 臺北 14:20
  const run = {
    phase: "code",
    startedAt: "2026-11-18T06:08:00Z",
    deadline: "2026-11-18T06:30:00Z", // 臺北 14:30
    heartbeatAt: "2026-11-18T06:19:50Z",
  };

  it("顯示階段名稱、已跑分鐘與期限（臺北時間），不寫死 30 分", () => {
    expect(runProgress(run, now)).toEqual({
      stale: false,
      text: "Codex 修改程式，已 12 分，期限 14:30",
    });
    expect(
      runProgress({ ...run, deadline: "2026-11-18T07:45:00Z" }, now)?.text,
    ).toBe("Codex 修改程式，已 12 分，期限 15:45");
  });

  it("剛開始、超過一小時與沒有期限時的寫法", () => {
    expect(
      runProgress({ ...run, startedAt: "2026-11-18T06:19:40Z" }, now)?.text,
    ).toBe("Codex 修改程式，剛開始，期限 14:30");
    expect(
      runProgress(
        {
          ...run,
          phase: "test",
          startedAt: "2026-11-18T05:05:00Z",
          deadline: null,
        },
        now,
      )?.text,
    ).toBe("執行測試，已 1 小時 15 分");
  });

  it("心跳超過 30 秒沒更新時改說狀態待確認", () => {
    const stale = {
      ...run,
      heartbeatAt: new Date(now - HEARTBEAT_STALE_MS - 1).toISOString(),
    };
    expect(runProgress(stale, now)).toEqual({
      stale: true,
      text: "Codex 修改程式，狀態待確認",
    });
    expect(heartbeatStale(stale.heartbeatAt, now)).toBe(true);
    expect(heartbeatStale(run.heartbeatAt, now)).toBe(false);
    expect(heartbeatStale(null, now)).toBe(false);
  });

  it("沒有進行中的執行時不顯示", () => {
    expect(runProgress({ phase: null, startedAt: null }, now)).toBeNull();
    expect(
      runProgress({ phase: "code", startedAt: undefined }, now),
    ).toBeNull();
  });

  it("不認得的階段代號原樣顯示", () => {
    expect(runProgress({ ...run, phase: "custom" }, now)?.text).toMatch(
      /^custom，/,
    );
  });
});

// 收件匣與任務清單的分組；伺服器依同一份清單完整載入未結束的任務（docs/conventions.md 第 3 節）。
describe("taskGroups：等待額度另列", () => {
  it("等待額度不算需要你處理", () => {
    expect(taskGroups.attention).toEqual(["awaiting_approval", "failed"]);
    expect(taskGroups.waiting).toEqual(["budget_wait"]);
    expect(taskGroups.attention).not.toContain("budget_wait");
  });

  it("各組不重疊，合起來就是伺服器完整載入的狀態", () => {
    const all = Object.values(taskGroups).flat() as TaskStatus[];
    expect(new Set(all).size).toBe(all.length);
    expect([...unfinishedStatuses].sort()).toEqual(
      [
        "awaiting_approval",
        "failed",
        "budget_wait",
        "queued",
        "running",
        "reviewing",
        "ready",
      ].sort(),
    );
    for (const s of unfinishedStatuses) expect(statusLabels[s]).toBeTruthy();
  });

  it("依伺服器 byStatus 加總：分頁標題只算待審核與失敗", () => {
    const byStatus = {
      awaiting_approval: 2,
      failed: 1,
      budget_wait: 4,
      merged: 9,
    };
    expect(countStatuses(byStatus, taskGroups.attention)).toBe(3);
    expect(countStatuses(byStatus, taskGroups.waiting)).toBe(4);
    expect(countStatuses(undefined, taskGroups.attention)).toBe(0);
  });
});
