import { expect, it } from "vitest";
import {
  longestPhase,
  phaseDurations,
  phaseMinutes,
  repairPhaseDetail,
} from "../shared/observation.js";

const at = (clock: string) => `2026-01-05T${clock}.000Z`;
/** 一次走到 PR、途中自動修復一次的修改任務（各階段時間取自真實執行的形狀）。 */
const repaired = [
  ["issue", "10:00:00"],
  ["archive", "10:00:03"],
  ["install", "10:01:00"],
  ["test", "10:01:27"],
  ["collect", "10:03:10"],
  ["context", "10:03:12"],
  ["code", "10:03:12"],
  ["collect", "10:08:54"],
  ["test", "10:08:55"],
  ["collect", "10:10:20"],
  ["review", "10:10:22"],
  ["collect", "10:13:46"],
  ["verify", "10:13:47"],
  ["code", "10:13:47"],
  ["collect", "10:18:39"],
  ["test", "10:18:40"],
  ["collect", "10:19:37"],
  ["review", "10:19:38"],
  ["collect", "10:22:53"],
  ["publish", "10:22:53"],
].map(([phase, clock]) => ({ phase, at: at(clock) }));

it("依準備、測試、修改、審查、修復、建立 PR 加總；收集差異算進前一個階段", () => {
  const spans = phaseDurations(repaired, at("10:23:00"));
  expect(spans.map((s) => [s.label, phaseMinutes(s.ms)])).toEqual([
    ["準備", "1.4 分鐘"],
    ["測試", "4.2 分鐘"],
    ["修改", "5.7 分鐘"],
    ["審查", "6.7 分鐘"],
    ["修復", "4.9 分鐘"],
    ["建立 PR", "不到 1 分鐘"],
  ]);
  expect(longestPhase(spans)?.label).toBe("審查");
});

it("接續修復的執行沒有「評估驗證結果」也認得出修復，執行中的最後一段算到現在", () => {
  const spans = phaseDurations(
    [
      { phase: "issue", at: at("11:00:00") },
      { phase: "install", at: at("11:01:00") },
      { phase: "code", at: at("11:02:00"), detail: repairPhaseDetail },
    ],
    at("11:12:30"),
  );
  expect(spans.map((s) => [s.group, s.ms / 60000])).toEqual([
    ["prepare", 2],
    ["repair", 10.5],
  ]);
});

it("沒有階段紀錄時沒有最長的階段", () => {
  expect(phaseDurations([], at("11:00:00"))).toEqual([]);
  expect(longestPhase([])).toBeUndefined();
});
