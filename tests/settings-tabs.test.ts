import { expect, it } from "vitest";
import {
  migrateSettingsHash,
  settingsTabFromUrl,
} from "../shared/settings-tabs.js";

it.each([
  ["settings-ai", "ai"],
  ["settings-notifications", "notifications"],
  ["settings-line", "notifications"],
  ["settings-services", "connections"],
  ["settings-secrets", "connections"],
  ["settings-data", "data"],
])("舊設定錨點 %s 對應新分頁並保留其他參數", (hash, tab) => {
  const url = new URL(
    `https://demo.invalid/settings/?source=demo&tab=old#${hash}`,
  );
  expect(settingsTabFromUrl(url)).toBe(tab);
  expect(migrateSettingsHash(url)?.href).toBe(
    `https://demo.invalid/settings/?source=demo&tab=${tab}`,
  );
});

it("未指定或無法辨識分頁時，使用 AI 與執行", () => {
  for (const suffix of ["", "?tab=unknown#other", "?tab=constructor"]) {
    const url = new URL(`https://demo.invalid/settings${suffix}`);
    expect(settingsTabFromUrl(url)).toBe("ai");
    expect(migrateSettingsHash(url)).toBeNull();
  }
});

it("辨識新分頁參數，且保留其他頁面的錨點", () => {
  expect(
    settingsTabFromUrl(new URL("https://demo.invalid/settings?tab=data")),
  ).toBe("data");
  expect(
    migrateSettingsHash(new URL("https://demo.invalid/chat#settings-line")),
  ).toBeNull();
});
