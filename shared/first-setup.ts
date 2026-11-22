import type { ConnectionSecretStatus } from "./connection-secrets.js";
import { discordServiceText } from "./status-glossary.js";
import type { Group, Project, Settings } from "./types.js";

type ChatSetup = {
  integrations: { line: boolean };
  connectionSecrets?: ConnectionSecretStatus;
  health: readonly { name: string; ok: boolean; detail?: string }[];
};

export function configuredChatPlatforms({
  integrations,
  connectionSecrets,
  health,
}: ChatSetup): Group["platform"][] {
  const platforms: Group["platform"][] = [];
  if (integrations.line) platforms.push("line");
  const discord = health.find((h) => h.name === "discord");
  // 只有擁有者可讀金鑰設定狀態，其他成員沿用連線檢查結果。
  if (
    connectionSecrets?.discordToken?.configured ??
    (discord && discord.detail !== discordServiceText.unconfigured)
  )
    platforms.push("discord");
  return platforms;
}

export function firstSetupStatus(
  state: ChatSetup & {
    projects: readonly Pick<
      Project,
      "id" | "enabled" | "validated_at" | "repo_missing_at"
    >[];
    groups: readonly Pick<
      Group,
      "enabled" | "left_at" | "platform" | "project_ids"
    >[];
    settings: Pick<
      Settings,
      | "ai_mode"
      | "paused"
      | "admin_notify_platform"
      | "admin_line_id"
      | "admin_discord_id"
    >;
  },
) {
  const ok = (name: string) =>
    state.health.some(
      (h) =>
        h.name === name &&
        h.ok &&
        (name !== "discord" || h.detail !== discordServiceText.unconfigured),
    );
  const projectIds = new Set(
    state.projects
      .filter((p) => p.enabled && p.validated_at && !p.repo_missing_at)
      .map((p) => p.id),
  );
  const present = state.groups.filter((g) => !g.left_at);
  const enabled = present.filter((g) => g.enabled);
  const routes = enabled.filter((g) =>
    g.project_ids.some((id) => projectIds.has(id)),
  );
  const configured = configuredChatPlatforms(state);
  const groups = routes.length ? routes : enabled.length ? enabled : present;
  const platforms = groups.length
    ? [...new Set(groups.map((g) => g.platform))]
    : configured;
  return {
    platforms,
    services: ok("github") && ok("runner"),
    chat: platforms.some(
      (platform) => configured.includes(platform) && ok(platform),
    ),
    ai: ok(state.settings.ai_mode === "api" ? "openai" : "codex"),
    project: projectIds.size > 0,
    route: routes.length > 0,
    dispatch: !state.settings.paused,
    notifications: !!(state.settings.admin_notify_platform === "discord"
      ? state.settings.admin_discord_id
      : state.settings.admin_line_id),
  };
}
