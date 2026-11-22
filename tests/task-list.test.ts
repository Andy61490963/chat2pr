import { describe, expect, it } from "vitest";
import {
  countTaskFilterConditions,
  isMergedInWeek,
  mergedWeekBounds,
  mergedWeekDay,
  taskListQuery,
} from "../shared/task-list.js";

const defaults = {
  statuses: [],
  group: "all",
  project: "all",
  by: "project",
  isHistory: false,
};

describe("任務篩選條件數", () => {
  it("兩種分頁各自的預設分組均不計入", () => {
    expect(countTaskFilterConditions(defaults)).toBe(0);
    expect(
      countTaskFilterConditions({ ...defaults, by: "none", isHistory: true }),
    ).toBe(0);
  });

  it("分別計入勾選的狀態、群組、未指定專案及非預設分組", () => {
    expect(
      countTaskFilterConditions({
        ...defaults,
        statuses: ["waiting", "ready", "ready", ""],
        group: "example-group",
        project: "none",
        by: "none",
      }),
    ).toBe(5);
  });

  it("歷史分頁忽略保留的狀態勾選，仍計入群組、專案及分組", () => {
    expect(
      countTaskFilterConditions({
        ...defaults,
        statuses: ["moving"],
        group: "example-group",
        project: "example-project",
        isHistory: true,
      }),
    ).toBe(3);
  });
});

describe("近七天已合併", () => {
  it("臺北午夜切換統計日，期間包含當天及前六天", () => {
    expect(mergedWeekDay(new Date("2026-12-31T15:59:59.999Z"))).toBe(
      "2026-12-31",
    );
    const day = mergedWeekDay(new Date("2026-12-31T16:00:00.000Z"));
    expect(day).toBe("2027-01-01");
    expect(mergedWeekBounds(day)).toEqual({
      since: new Date("2026-12-25T16:00:00.000Z"),
      until: new Date("2027-01-01T16:00:00.000Z"),
    });
  });

  it("含起日午夜，排除前一毫秒、隔日午夜及期間內的取消任務", () => {
    const week = mergedWeekBounds("2027-01-01")!;
    for (const [updated_at, included] of [
      ["2026-12-25T15:59:59.999Z", false],
      ["2026-12-25T16:00:00.000Z", true],
      ["2027-01-01T15:59:59.999Z", true],
      ["2027-01-01T16:00:00.000Z", false],
    ] as const) {
      expect(isMergedInWeek({ status: "merged", updated_at }, week)).toBe(
        included,
      );
    }
    expect(
      isMergedInWeek(
        { status: "cancelled", updated_at: "2027-01-01T10:00:00Z" },
        week,
      ),
    ).toBe(false);
  });

  it("拒絕不存在的日期，下鑽網址保留統計日", () => {
    expect(mergedWeekBounds("2026-02-29")).toBeNull();
    expect(mergedWeekBounds("2026-2-01")).toBeNull();
    expect(
      Object.fromEntries(taskListQuery({ mergedWeek: "2027-01-01" })),
    ).toEqual({
      filter: "closed",
      mergedWeek: "2027-01-01",
    });
  });
});
