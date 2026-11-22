export const settingsTabs = {
  ai: "AI 與執行",
  notifications: "通知",
  connections: "連線與金鑰",
  data: "資料與外觀",
} as const;

export type SettingsTab = keyof typeof settingsTabs;
export const defaultSettingsTab: SettingsTab = "ai";

const legacySettingsTabs = {
  "#settings-ai": "ai",
  "#settings-notifications": "notifications",
  "#settings-line": "notifications",
  "#settings-services": "connections",
  "#settings-secrets": "connections",
  "#settings-data": "data",
} as const satisfies Record<string, SettingsTab>;

export function readSettingsTab(value: string | null): SettingsTab {
  return value && Object.hasOwn(settingsTabs, value)
    ? (value as SettingsTab)
    : defaultSettingsTab;
}

export function settingsTabFromUrl(url: URL): SettingsTab {
  const legacy =
    legacySettingsTabs[url.hash as keyof typeof legacySettingsTabs];
  return legacy ?? readSettingsTab(url.searchParams.get("tab"));
}

export function migrateSettingsHash(url: URL): URL | null {
  if (url.pathname.replace(/\/+$/, "") !== "/settings") return null;
  if (!Object.hasOwn(legacySettingsTabs, url.hash)) return null;
  const next = new URL(url);
  next.searchParams.set("tab", settingsTabFromUrl(url));
  next.hash = "";
  return next;
}
