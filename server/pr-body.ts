import { formatBytes, type ExcludedSummary } from "../shared/build-output.js";

// 組成給人閱讀的 PR 說明：先說做了什麼，再用一行交代測試結果，
// 完整測試輸出收進可展開區塊並略過編譯警告，避免警告洗版蓋掉重點。
const noise = /\bwarning\b|^\s+at\s|^npm (notice|warn)\b|^\s*$/i;
const keyLine =
  /(Passed!|Failed!|Total tests|Test Files|^\s*Tests\s+\d|\d+\s+(passed|failed)\b|built in|\berror\b|\bFAIL\b|^ok\b|^FAILED|Ran \d+ tests?|^OK\b)/i;

export function testHighlights(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => !noise.test(l));
  return {
    headline: lines
      .filter((l) => keyLine.test(l))
      .slice(-4)
      .map((l) => l.trim()),
    tail: lines.slice(-40),
  };
}

// 截短給人看的文字時停在句尾或換行，並標示還有內容，避免斷在半句。
export function clip(text: string, max: number, more = "…") {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(
    ...["。", "；", "\n", "！", "？", ". "].map((p) => head.lastIndexOf(p)),
  );
  return `${(cut > max * 0.5 ? head.slice(0, cut + 1) : head).trimEnd()}${more}`;
}

// 驗證失敗的簡短說明：有審查意見就列意見，否則列測試輸出的關鍵行。
export function failureSummary(findings: string[], testOutput: string) {
  if (findings.length) return findings.join("\n");
  const { headline, tail } = testHighlights(testOutput);
  return `測試未通過：${(headline.length ? headline : tail.slice(-5)).join("；")}`;
}

function verificationLine(o: {
  verification?: string;
  dataSource?: string;
  limitations?: string;
}) {
  if (o.verification === "build") return "建置：通過；未執行自動測試";
  if (o.verification === "partial")
    return `測試：部分通過；AI 依環境限制縮小了範圍，未涵蓋：${o.limitations?.trim().slice(0, 300) || "未說明"}`;
  if (o.dataSource === "inferred")
    return "測試：通過；資料庫結構由 AI 從程式碼推測，可能和真實資料庫不同";
  if (o.dataSource === "snapshot") return "測試：通過；資料庫以結構快照模擬";
  return "測試：通過";
}

export function prReport(o: {
  codexSummary: string;
  testCommand: string;
  testOutput: string;
  verification?: "tests" | "partial" | "build" | "needs_input";
  dataSource?: "project" | "snapshot" | "inferred" | "none";
  limitations?: string;
  reviewNotes?: string[];
  excluded?: ExcludedSummary;
}) {
  const summary =
    o.codexSummary.trim().slice(0, 4000) || "（Codex 未提供說明）";
  const lines = ["## 這次做了什麼", "", summary, "", "## 驗證", ""];
  if (o.testCommand.trim()) {
    const { headline, tail } = testHighlights(o.testOutput);
    lines.push(
      `- ${verificationLine(o)}（\`${o.testCommand.trim().slice(0, 200)}\`）${headline.length ? `\n  - ${headline.join("\n  - ")}` : ""}`,
      "- 獨立審查：通過",
    );
    if (tail.length)
      lines.push(
        "",
        "<details><summary>測試輸出節錄（已略過編譯警告）</summary>",
        "",
        "```text",
        tail.join("\n").replace(/```/g, ""),
        "```",
        "",
        "</details>",
      );
  } else
    lines.push(
      "- 測試：此專案未設定測試命令，未執行自動測試",
      "- 獨立審查：通過",
    );
  if (o.excluded?.files) lines.push("", ...excludedSection(o.excluded));
  const notes = (o.reviewNotes ?? [])
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (notes.length)
    lines.push(
      "",
      "## 待人工確認",
      "",
      "審查員認為以下項目需要人、正式環境或真實資料才能確認，合併前請自行檢查：",
      "",
      ...notes.map((n) => `- [ ] ${clip(n.replace(/\s+/g, " "), 400)}`),
    );
  return lines.join("\n");
}

// 被排除的路徑一定列在 PR 說明，誤排除真正的修改時審查者看得到。
function excludedSection(e: ExcludedSummary) {
  // 路徑放在表格的程式碼格內：拿掉會破壞格式的反引號、直線與換行。
  const cell = (text: string) => text.replace(/[|`\r\n]/g, "_");
  const rest = e.totalGroups - e.groups.length;
  return [
    "## 收集時排除的建置產物",
    "",
    `這次新產生、版本控制原本沒有追蹤的 ${e.files} 個檔案（${formatBytes(e.bytes)}）看起來是建置產物，沒有放進這個 PR。若其中有真正的修改，請到看板專案頁進階設定的「收集時排除」移除對應規則後重試。`,
    "",
    "| 路徑 | 檔案數 | 大小 | 規則 |",
    "| --- | ---: | ---: | --- |",
    ...e.groups.map(
      (g) =>
        `| \`${cell(g.path)}\` | ${g.files} | ${formatBytes(g.bytes)} | \`${cell(g.rule)}\` |`,
    ),
    ...(rest > 0 ? ["", `另有 ${rest} 組未列出。`] : []),
  ];
}

const noDefect =
  /^(?:經檢查)?(?:未|沒有|無)(?:發現|找到)?(?:任何)?(?:會?阻[擋礙](?:發布)?的?)?(?:缺陷|問題|錯誤)|^no (?:blocking )?(?:issues|defects|findings)\b/i;

/**
 * 解讀審查結果：只有阻擋問題會讓驗證失敗。
 * 審查員把「未發現缺陷」之類的結論寫進 findings 時不算阻擋；
 * passed=false 卻沒有任何阻擋問題時也視為通過，否則自動修復沒有東西可以修。
 */
export function reviewVerdict(result: unknown): {
  passed: boolean;
  findings: string[];
  notes: string[];
} {
  const r = (result ?? {}) as Record<string, unknown>;
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
  if (!Array.isArray(r.findings))
    return { passed: false, findings: ["審查結果格式不符"], notes: [] };
  const findings = list(r.findings).filter((f) => !noDefect.test(f));
  return { passed: findings.length === 0, findings, notes: list(r.notes) };
}
