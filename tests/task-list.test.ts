import { describe, expect, it } from "vitest";
import { countTaskFilterConditions } from "../shared/task-list.js";

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
