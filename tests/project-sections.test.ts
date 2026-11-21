import { describe, expect, it } from "vitest";
import { projectListSections, repoNotice } from "../shared/project-setup.js";
import type { Group, Project } from "../shared/types.js";

const timestamp = "2026-01-01T00:00:00Z";
const project: Project = {
  id: "demo",
  name: "示範專案",
  repo: "example/demo",
  description: "",
  config_version: 1,
  base_branch: "main",
  image: "demo:local",
  install_command: "",
  test_command: "",
  sensitive_paths: [],
  enabled: true,
  validated_at: timestamp,
  validation_error: null,
  created_at: timestamp,
};
const group: Group = {
  id: "example-group",
  platform: "line",
  name: "範例群組",
  project_ids: [project.id],
  enabled: true,
  trigger_mode: "auto",
  reply_mode: "all",
  trigger_version: 1,
  binding_version: 1,
  triage_failures: 0,
  triage_error: null,
  first_pending_at: null,
  last_pending_at: null,
};

describe("專案列表分區", () => {
  const waitingForInput: Project["setup_input"] = {
    id: "example-question",
    configVersion: 1,
    reason: "缺少測試說明",
    questions: [{ kind: "information", question: "請問要執行哪些測試？" }],
    createdAt: timestamp,
  };
  const cases = [
    ["找不到儲存庫", { repo_missing_at: timestamp }, true, "attention"],
    ["等待補充設定", { setup_input: waitingForInput }, true, "attention"],
    ["沒有驗證結果", { validated_at: null }, false, "attention"],
    [
      "驗證失敗",
      {
        validated_at: null,
        validation_error: "範例測試失敗，請修正後重新驗證。",
      },
      true,
      "attention",
    ],
    [
      "儲存庫接回後需要重新驗證",
      { validated_at: null, validation_error: repoNotice.found },
      false,
      "attention",
    ],
    ["已驗證且有群組綁定", {}, true, "ready"],
    ["已驗證但沒有群組綁定", {}, false, "unbound"],
    ["已驗證且有群組綁定但已停用", { enabled: false }, true, "attention"],
    ["已驗證且已停用但沒有群組綁定", { enabled: false }, false, "unbound"],
    [
      "重新驗證暫時失敗但保留驗證結果",
      { validation_error: "範例服務逾時，請稍後重新驗證。" },
      true,
      "ready",
    ],
  ] satisfies [
    string,
    Partial<Project>,
    boolean,
    keyof ReturnType<typeof projectListSections>,
  ][];

  it.each(cases)(
    "%s 依原狀態分區，驗證中也停留在同一區",
    (_, fields, bound, section) => {
      for (const validation_progress of [
        undefined,
        "你的專案正在執行基底測試。",
      ]) {
        const entry = { ...project, ...fields, validation_progress };
        const bindings = bound ? [group] : [];
        const groups = bound
          ? [group]
          : [{ ...group, project_ids: ["other-demo"] }];
        expect(projectListSections([entry], groups)).toEqual({
          attention: [],
          ready: [],
          unbound: [],
          [section]: [{ project: entry, groups: bindings }],
        });
      }
    },
  );

  it("各區依名稱排序，保留原始專案清單順序", () => {
    const projects = ["10", "2", "1"].flatMap((suffix) => [
      { ...project, id: `ready-${suffix}`, name: `範例專案 ${suffix}` },
      { ...project, name: `示範專案 ${suffix}`, id: `unbound-${suffix}` },
      {
        ...project,
        id: `attention-${suffix}`,
        name: `待處理專案 ${suffix}`,
        validated_at: null,
      },
    ]);
    const originalOrder = projects.map(({ id }) => id);
    const sections = projectListSections(projects, [
      { ...group, project_ids: ["ready-1", "ready-2", "ready-10"] },
    ]);
    for (const section of ["attention", "ready", "unbound"] as const) {
      expect(sections[section].map(({ project }) => project.id)).toEqual([
        `${section}-1`,
        `${section}-2`,
        `${section}-10`,
      ]);
    }
    expect(projects.map(({ id }) => id)).toEqual(originalOrder);
  });
});
