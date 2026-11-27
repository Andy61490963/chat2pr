import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errors } from "@playwright/test";

export async function captureReferenceTarget(
  reference: boolean,
  waitForAttachment: () => Promise<void>,
) {
  try {
    await waitForAttachment();
    return true;
  } catch (error) {
    if (reference && error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

export function newScreens(before: string[], after: string[]) {
  const previous = new Set(before);
  return after
    .filter((file) => file.endsWith(".png") && !previous.has(file))
    .sort();
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const dir = process.argv[2];
  const added = newScreens(
    readdirSync(join(dir, "改版前")),
    readdirSync(join(dir, "改版後")),
  );
  const report = [
    "## 新增畫面",
    "",
    ...added.map((file) => "- " + file),
    "",
  ].join("\n");
  writeFileSync(join(dir, "新增畫面.md"), report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
