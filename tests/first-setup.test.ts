import { expect, it } from "vitest";
import {
  configuredChatPlatforms,
  firstSetupStatus,
} from "../shared/first-setup.js";
import { discordServiceText } from "../shared/status-glossary.js";

const date = "2026-01-01T00:00:00Z";
const project = { id: "demo-project", enabled: true, validated_at: date };
const group = {
  enabled: true,
  project_ids: [project.id],
  platform: "line",
} as const;
const state = {
  groups: [{ ...group, project_ids: [...group.project_ids] }],
  projects: [project],
  health: ["github", "runner", "codex", "line"].map((name) => ({
    name,
    ok: true,
  })),
  integrations: { line: true },
  settings: { ai_mode: "subscription", paused: false, admin_line_id: null },
} satisfies Parameters<typeof firstSetupStatus>[0];

it("啟用群組綁到已驗證且啟用的專案時，選配通知未配對也有可用路徑", () => {
  expect(firstSetupStatus(state)).toEqual({
    platforms: ["line"],
    services: true,
    chat: true,
    ai: true,
    project: true,
    route: true,
    dispatch: true,
    notifications: false,
  });
});

it("唯一群組只綁到未驗證專案時，其他專案通過驗證仍無可用路徑", () => {
  const status = firstSetupStatus({
    ...state,
    projects: [
      project,
      { id: "other-project", enabled: true, validated_at: null },
    ],
    groups: [{ ...group, project_ids: ["other-project"] }],
  });
  expect(status).toMatchObject({ project: true, route: false });
});

const discord = {
  ...state.groups[0],
  platform: "discord",
} as const;
const discordHealth = {
  name: "discord",
  ok: true,
  detail: discordServiceText.connected,
};

it("只用 Discord 收件時，沒有設定 LINE 也能完成連線與路徑", () => {
  const status = firstSetupStatus({
    ...state,
    integrations: { line: false },
    groups: [discord],
    health: [...state.health.filter((h) => h.name !== "line"), discordHealth],
  });
  expect(status).toMatchObject({
    platforms: ["discord"],
    chat: true,
    route: true,
  });
});

it("只有可派工路徑的平台連線可完成收件，Discord 未設定的正常讀數也不算接通", () => {
  const status = firstSetupStatus({
    ...state,
    groups: [discord, { ...group, project_ids: [] }],
    health: [
      ...state.health,
      { ...discordHealth, detail: discordServiceText.unconfigured },
    ],
  });
  expect(status).toMatchObject({
    platforms: ["discord"],
    chat: false,
    route: true,
  });
  expect(
    configuredChatPlatforms({
      integrations: { line: false },
      health: [{ ...discordHealth, detail: discordServiceText.unconfigured }],
    }),
  ).toEqual([]);
});

it("已停用或機器人已離開的群組，以及停用或找不到儲存庫的專案，都不構成路徑", () => {
  for (const group of [
    { ...state.groups[0], enabled: false },
    { ...state.groups[0], left_at: date },
  ]) {
    expect(firstSetupStatus({ ...state, groups: [group] }).route).toBe(false);
  }
  for (const unavailable of [
    { ...project, enabled: false },
    { ...project, repo_missing_at: date },
  ]) {
    expect(firstSetupStatus({ ...state, projects: [unavailable] }).route).toBe(
      false,
    );
  }
});
