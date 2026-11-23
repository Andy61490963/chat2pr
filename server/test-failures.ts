import { safeDetail } from "./observation.js";

/**
 * 從測試輸出擷取失敗的測試名稱與第一段錯誤訊息（#248）。
 *
 * 認得 .NET（xUnit 執行器的 `[FAIL]` 行與 `dotnet test` 的 `Failed …`／`Error Message:`）、
 * Vitest（` FAIL  檔案 > 測試`）、Jest（`● 測試`）與 pytest（`FAILED 路徑::測試 - 訊息`）。
 * 認不出任何失敗的測試時回傳 null，呼叫端維持原本只挑錯誤行的做法。
 */
export interface TestFailure {
  name: string;
  /** 第一段錯誤訊息；輸出裡沒有時為空字串。 */
  message: string;
}
export interface TestFailures {
  /** 依輸出中出現的順序，最多 MAX_LISTED 個。 */
  tests: TestFailure[];
  /** 沒有列出的失敗測試數。 */
  more: number;
}

export const MAX_LISTED = 10;
const NAME_LIMIT = 200;
const MESSAGE_LIMIT = 300;
const MESSAGE_LINES = 3;

type Kind = "xunit" | "dotnet" | "jest" | "vitest";
const ansi = /\x1b\[[0-9;]*[a-zA-Z]/g;
const xunitPrefix = /^\[xUnit\.net [\d:.]+\]\s?/;
const headers: [Kind, RegExp][] = [
  ["xunit", /^\[xUnit\.net [\d:.]+\]\s+(.+?)\s+\[FAIL\]\s*$/],
  // 「Failed!  - Failed: 2, …」是統計行，不是測試名稱（Failed 後面緊接驚嘆號）。
  ["dotnet", /^\s*Failed\s+(.+?)\s+\[[^\]]*\]\s*$/],
  ["jest", /^\s*●\s+(?!Console\b)(.+?)\s*$/],
  // Vitest 每個測試寫成「檔案 > 區塊 > 測試」，整個檔案失敗時是「檔案 [ 檔案 ]」；Jest 只有檔案的 FAIL 行不算。
  ["vitest", /^\s*FAIL\s+(\S.*?(?: > .+?| \[ .+? \]))\s*$/],
];
const pytest = /^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.+?))?\s*$/;
// 錯誤訊息到這裡就結束：堆疊、程式碼片段、下一段標題。
const messageEnd =
  /^\s*(?:at\s|Stack Trace:|Standard (?:Output|Error) Messages:|Output:|❯|⎯|>?\s*\d+\s*\|)/;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

export function parseTestFailures(output: string): TestFailures | null {
  const found = new Map<string, string[]>();
  let current: { kind: Kind; lines: string[]; started: boolean } | null = null;
  const finish = () => {
    current = null;
  };
  for (const raw of output.replace(ansi, "").split(/\r?\n/)) {
    const header = headers
      .map(([kind, pattern]) => ({ kind, match: raw.match(pattern) }))
      .find((h) => h.match);
    if (header?.match) {
      const name = clip(safeDetail(header.match[1].trim()), NAME_LIMIT);
      if (!found.has(name)) found.set(name, []);
      const lines = found.get(name)!;
      // 同一個測試在 xUnit 與 dotnet 兩種格式各出現一次：已經有訊息就不再收。
      current = {
        kind: header.kind,
        lines: lines.length ? [] : lines,
        started: header.kind !== "dotnet",
      };
      continue;
    }
    const py = raw.match(pytest);
    if (py) {
      const name = clip(safeDetail(py[1]), NAME_LIMIT);
      if (!found.get(name)?.length) found.set(name, py[2] ? [py[2]] : []);
      finish();
      continue;
    }
    const c = current as { kind: Kind; lines: string[]; started: boolean } | null;
    if (!c) continue;
    let line = raw;
    if (c.kind === "xunit") {
      if (!xunitPrefix.test(line)) {
        finish();
        continue;
      }
      line = line.replace(xunitPrefix, "");
    }
    if (c.kind === "dotnet" && /^\s*Error Message:\s*$/.test(line)) {
      c.started = true;
      continue;
    }
    if (messageEnd.test(line)) {
      finish();
      continue;
    }
    const text = line.trim();
    if (!text) {
      if (c.lines.length) finish();
      continue;
    }
    if (!c.started) continue;
    c.lines.push(text);
    if (c.lines.length >= MESSAGE_LINES) finish();
  }
  if (!found.size) return null;
  const all = [...found].map(([name, lines]) => ({
    name,
    message: clip(safeDetail(lines.join(" ")), MESSAGE_LIMIT),
  }));
  return { tests: all.slice(0, MAX_LISTED), more: Math.max(0, all.length - MAX_LISTED) };
}

/** 看板與群組看的失敗清單；每個測試一行。 */
export function describeTestFailures(failures: TestFailures) {
  const total = failures.tests.length + failures.more;
  return [
    `失敗的測試（共 ${total} 個）：`,
    ...failures.tests.map(
      (t) => `・${t.name}${t.message ? `：${t.message}` : ""}`,
    ),
    ...(failures.more
      ? [`另有 ${failures.more} 個失敗的測試，完整清單見執行紀錄。`]
      : []),
  ].join("\n");
}
