import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface StyleEntry {
  file: string;
  line: number;
  column: number;
  reason: string;
  value: string;
  context: string;
}

const header = "檔案及原始行欄\t待遷移原因\t樣式\t來源識別";
const baselinePath = "tests/design-tokens.baseline.tsv";

export const fingerprint = (line: string) =>
  createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);

function formatRow(e: StyleEntry) {
  return [
    e.file + ":" + e.line + ":" + e.column,
    e.reason,
    e.value,
    e.context,
  ].join("\t");
}

export function formatBaseline(entries: StyleEntry[]) {
  return [header, ...entries.map(formatRow)].join("\n") + "\n";
}

export function parseBaseline(text: string): StyleEntry[] {
  const [title, ...lines] = text.trimEnd().split(/\r?\n/);
  if (title !== header) throw new Error("設計規範基準缺少欄名");
  return lines.map((row) => {
    const [location, reason, value, context] = row.split("\t");
    const match = /^(src\/.+):(\d+):(\d+)$/.exec(location);
    if (!match || !reason || !value || !/^[\da-f]{16}$/.test(context)) {
      throw new Error("無法辨識基準列：" + row);
    }
    return {
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      reason,
      value,
      context,
    };
  });
}

export function checkBaseline(
  current: string,
  previous: string | null,
  readSource?: (file: string) => string,
) {
  const allowed = new Set(
    previous === null ? [] : parseBaseline(previous).map(formatRow),
  );
  const seen = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const entry of parseBaseline(current)) {
    const row = formatRow(entry);
    if (previous !== null) {
      if (!allowed.delete(row)) throw new Error("基準只能刪除既有列：" + row);
      continue;
    }
    // 首次導入時基底沒有基準檔，改用基底本來就有的來源行與欄位查核。
    if (!sources.has(entry.file))
      sources.set(entry.file, readSource?.(entry.file).split(/\r?\n/) ?? []);
    const line = sources.get(entry.file)?.[entry.line - 1];
    const location = [entry.file, entry.line, entry.column].join(":");
    if (
      !line ||
      fingerprint(line) !== entry.context ||
      !line.startsWith(entry.value, entry.column - 1) ||
      seen.has(location)
    ) {
      throw new Error("基底版本沒有這筆樣式：" + row);
    }
    seen.add(location);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const base = process.argv[2];
  if (!/^[\da-f]{40}$/.test(base)) throw new Error("缺少待比對的基底版本");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" });
  const exists = git("ls-tree", "--name-only", base, "--", baselinePath).trim();
  const readBase = (file: string) => git("show", base + ":" + file);
  checkBaseline(
    readFileSync(baselinePath, "utf8"),
    exists ? readBase(baselinePath) : null,
    readBase,
  );
}
