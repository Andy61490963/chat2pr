import { createHash } from "node:crypto";

interface BaselineEntry {
  file: string;
  reason: string;
  value: string;
  context: string;
}

export interface StyleEntry extends BaselineEntry {
  line: number;
  column: number;
}

const header = "檔案\t待遷移原因\t樣式\t來源識別";
export const baselinePath = "tests/design-tokens.baseline.tsv";

export const fingerprint = (line: string) =>
  createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);

function key({ file, reason, value, context }: BaselineEntry) {
  return [file, reason, value, context].join("\t");
}

export function formatBaseline(entries: BaselineEntry[]) {
  return [header, ...entries.map(key).sort()].join("\n") + "\n";
}

export function parseBaseline(text: string): BaselineEntry[] {
  const [title, ...lines] = text.trimEnd().split(/\r?\n/);
  if (title !== header) throw new Error("設計規範基準缺少欄名");
  return lines.map((row) => {
    const [file, reason, value, context, extra] = row.split("\t");
    if (
      !/^(src|shared)\//.test(file) ||
      !reason ||
      !value ||
      !/^[\da-f]{16}$/.test(context) ||
      extra !== undefined
    )
      throw new Error("無法辨識基準列：" + row);
    return { file, reason, value, context };
  });
}

export function baselineDifference<
  T extends BaselineEntry,
  U extends BaselineEntry,
>(entries: T[], base: U[]) {
  const remaining = new Map<string, U[]>();
  for (const entry of base) {
    const id = key(entry);
    const group = remaining.get(id);
    if (group) group.push(entry);
    else remaining.set(id, [entry]);
  }
  const added = entries.filter((entry) => !remaining.get(key(entry))?.pop());
  return { added, removed: [...remaining.values()].flat() };
}

export function checkBaseline(
  current: string,
  previous: string | null,
  inherited: () => StyleEntry[] = () => [],
  currentSource: () => StyleEntry[] = () => [],
) {
  const allowed = previous === null ? inherited() : parseBaseline(previous);
  const { added } = baselineDifference(parseBaseline(current), allowed);
  if (added.length) {
    const message =
      previous === null ? "基底版本沒有這筆樣式" : "基準只能刪除既有列";
    const locations = new Map<string, StyleEntry[]>();
    for (const entry of currentSource()) {
      const id = key(entry);
      const matches = locations.get(id) ?? [];
      matches.push(entry);
      locations.set(id, matches);
    }
    const details = added.map((entry) => {
      const source = locations.get(key(entry))?.pop();
      const location = source
        ? `${source.file}:${source.line}:${source.column}`
        : entry.file;
      return `${location}　${entry.value}（${entry.reason}）。若這一行被修改過，請順手換成 token；新增的樣式也須使用 token。`;
    });
    throw new Error(message + "：\n" + details.join("\n"));
  }
}

export function comparisonBase(event: string, before?: string) {
  // PR 檢出的是 GitHub 的合併提交，第一個父版本就是此次測試使用的主線。
  if (event === "pull_request") return "HEAD^1";
  if (event !== "push" || !before || !/^[\da-f]{40}$/.test(before))
    throw new Error("缺少待比對的推送前版本");
  return /^0+$/.test(before) ? null : before;
}
