import { describe, expect, it } from "vitest";
import { pickRun, pinFor } from "../shared/run-pick.js";
import { HOST_HEALTH, memoryHold } from "../shared/host-hold.js";

const old = { id: "run-old", outcome: "failed" };
const fresh = { id: "run-new", outcome: null };

// 在「執行紀錄」分頁按重試後，新執行插在清單最前面，畫面要跟著切過去。
describe("執行紀錄要顯示哪一次（pickRun）", () => {
  it("跟隨最新時，重試後回傳新插入的執行", () => {
    expect(pickRun([old], null)).toBe(old);
    expect(pickRun([fresh, old], null)).toBe(fresh);
  });

  it("手動固定在舊紀錄時，新執行出現後仍顯示舊的那次", () => {
    expect(pickRun([fresh, old], "run-old")).toBe(old);
  });

  it("固定的那次已不在清單時退回最新", () => {
    expect(pickRun([fresh, old], "run-gone")).toBe(fresh);
  });

  it("沒有任何執行時回傳 undefined", () => {
    expect(pickRun([], null)).toBeUndefined();
  });

  it("選單選回最新那一列就恢復跟隨，選舊紀錄才固定", () => {
    expect(pinFor([fresh, old], "run-new")).toBeNull();
    expect(pinFor([fresh, old], "run-old")).toBe("run-old");
  });
});

// 頁首「派工自動暫停」與橫幅：只認新鮮的 host_resources 異常，過期的不算。
describe("記憶體不足自動暫停派工（memoryHold）", () => {
  const now = Date.parse("2026-11-18T08:00:00Z");
  const row = (ok: boolean, minutesAgo: number) => ({
    name: HOST_HEALTH,
    ok,
    detail:
      "Windows 主機可用記憶體只剩 1.6 GB（低於 2 GB），暫停派新工作，回升到 2.5 GB 以上才恢復；執行中的工作不受影響",
    checked_at: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("異常且在三分鐘內時回傳原因", () => {
    expect(memoryHold([row(false, 1)], now)).toContain("暫停派新工作");
  });

  it("原因去掉句尾標點，橫幅接句時不會出現「。。」", () => {
    expect(
      memoryHold([{ ...row(false, 1), detail: "主機記憶體不足。" }], now),
    ).toBe("主機記憶體不足");
    expect(memoryHold([{ ...row(false, 1), detail: "" }], now)).toBe(
      "主機記憶體不足，暫停派新工作",
    );
  });

  it("結果過期（4 分鐘前）時不算暫停", () => {
    expect(memoryHold([row(false, 4)], now)).toBeNull();
  });

  it("正常、沒有這一項或沒有健康資料時不算暫停", () => {
    expect(memoryHold([row(true, 0)], now)).toBeNull();
    expect(
      memoryHold(
        [{ name: "line", ok: false, detail: "x", checked_at: "" }],
        now,
      ),
    ).toBeNull();
    expect(memoryHold(undefined, now)).toBeNull();
  });
});
