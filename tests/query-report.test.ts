import { it, expect } from "vitest";
import sharp from "sharp";
import {
  normalizeReportMarkdown,
  remarkReportSections,
} from "../shared/query-report.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

function renderReport(answer: string) {
  return renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkReportSections],
      skipHtml: true,
      children: answer,
    }),
  );
}

it("短答與圖解保持顯示，詳細說明及程式依據各自收合", () => {
  const html = renderReport(
    "## 先看重點\n用編號配對。\n## 簡易圖解\n讀取 → 配對\n## 詳細資訊\n名稱只在補建時使用。\n## 程式依據\nRepository.cs:42",
  );
  expect(html).toContain("<p>用編號配對。</p>");
  expect(html).toContain(
    '<details class="report-details"><summary>展開詳細說明</summary>',
  );
  expect(html).toContain(
    '<details class="report-details"><summary>查看程式依據</summary>',
  );
  expect(html).not.toContain(" open");
  expect(html.indexOf("讀取 → 配對")).toBeLessThan(html.indexOf("<details"));
});

it("舊格式、只有詳細資訊與簡短回答仍完整呈現", () => {
  for (const answer of [
    "用編號配對。",
    "**一、欄位**\n用途說明",
    "## 詳細資訊\n唯一的回答",
  ]) {
    expect(renderReport(answer)).not.toContain("<details");
  }
  expect(renderReport("## 先看重點\n短答\n## 詳細資訊\n舊報告證據")).toContain(
    "舊報告證據",
  );
});

it("程式碼標題不誤切、跨段連結保留、原始 HTML 仍不執行", () => {
  const html = renderReport(
    "摘要 [文件][ref]\n```md\n## 詳細資訊\n```\n## 詳細資訊\n補充\n\n[ref]: https://example.test/docs\n<script>alert(1)</script>",
  );
  expect(html.match(/<details/g)).toHaveLength(1);
  expect(html).toContain('href="https://example.test/docs"');
  expect(html).toContain('<code class="language-md">## 詳細資訊');
  expect(html).not.toContain("<script");
});

it("中文重點的冒號不會讓粗體星號外露", () => {
  expect(normalizeReportMarkdown("**用途：**用編號配對。")).toBe(
    " **用途：** 用編號配對。",
  );
  expect(normalizeReportMarkdown("`**原樣：**`")).toBe("`**原樣：**`");
});
import {
  prepareReportImages,
  querySummary,
  reportForGitHub,
} from "../server/query-report.js";

const report =
  `## 先看重點
**EQM_MASTER_NO** 用來對應機台，` +
  "`EQM_MASTER_NAME`" +
  `用來顯示名稱。

- 名稱不參與配對。
- 找不到編號時需要確認資料。

## 簡易圖解
\`\`\`mermaid
flowchart LR
A[讀取] --> B[對應] --> C[結果]
\`\`\`

## 詳細資訊
![實際畫面](report:img-1)
依據：Repository.cs:42。`;

it("LINE 保留開頭完整重點和欄位名稱，不帶圖形、圖片或程式證據", () => {
  expect(querySummary(report)).toBe(
    "EQM_MASTER_NO 用來對應機台，EQM_MASTER_NAME用來顯示名稱。\n\n• 名稱不參與配對。\n• 找不到編號時需要確認資料。",
  );
});
it("LINE 將欄位比較表轉成白話列點", () => {
  expect(
    querySummary(
      "## 先看重點\n使用編號配對。\n\n| 欄位 | 用途 |\n| --- | --- |\n| `EQM_MASTER_NO` | 比對機台 |\n| `EQM_MASTER_NAME` | 補建名稱 |\n\n## 程式依據\n不要出現在摘要",
    ),
  ).toBe(
    "使用編號配對。\n\n• EQM_MASTER_NO：比對機台\n• EQM_MASTER_NAME：補建名稱",
  );
});
it("舊回答與資訊不足回答仍提供可讀摘要", () => {
  expect(querySummary("先讀取。\n~~~mermaid\nflowchart LR\nA --> B\n~~~")).toBe(
    "先讀取。",
  );
  expect(querySummary("先讀取。\n```mermaid\nflowchart LR\nA --> B")).toBe(
    "先讀取。",
  );
  expect(querySummary("目前無法確認，缺少設定檔。")).toBe(
    "目前無法確認，缺少設定檔。",
  );
  expect(
    querySummary(
      "先讀取資料。\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\n![圖](report:img-1)",
    ),
  ).toBe("先讀取資料。");
  expect(querySummary("## 先看重點\n" + "這是完整句子。".repeat(200))).toMatch(
    /。…（完整報告請看看板）$/,
  );
  expect(
    querySummary("## 先看重點\n" + "這是完整句子。".repeat(200)).length,
  ).toBeLessThanOrEqual(320);
});
it("GitHub 保留 Mermaid 並將受保護圖片改為報告連結", () => {
  const result = reportForGitHub(report, "https://example.test/tasks?task=123");
  expect(result).toContain(
    "[查看圖片：實際畫面](https://example.test/tasks?task=123)",
  );
  expect(result).toContain("flowchart LR");
  expect(result).not.toContain("](report:");
});
async function image() {
  const data = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  return {
    key: "img-1",
    caption: "查詢結果",
    kind: "repository",
    source: "docs/result.png",
    mime: "image/png",
    data: data.toString("base64"),
  };
}
it("附件驗證實際解碼、來源、張數與檔案大小，失敗仍保留文字報告", async () => {
  const valid = await image();
  expect((await prepareReportImages([valid], [])).images).toHaveLength(1);
  for (const invalid of [
    { ...valid, source: "../secret.png" },
    { ...valid, kind: "message", source: "other-group" },
    { ...valid, mime: "image/jpeg" },
    { ...valid, mime: "image/svg+xml" },
    { ...valid, data: Buffer.alloc(2097153).toString("base64") },
    { ...valid, data: Buffer.from("not an image").toString("base64") },
  ]) {
    const result = await prepareReportImages([invalid], []);
    expect(result.images).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  }
  expect(
    (await prepareReportImages([valid, valid, valid, valid], [])).images,
  ).toHaveLength(0);
  expect((await prepareReportImages([valid, valid], [])).images).toHaveLength(
    1,
  );
});
it("真實截圖必須有時間與網址，來源網址不保存登入與查詢參數", async () => {
  const value = {
    ...(await image()),
    kind: "screenshot",
    source: "https://fake:fictional@example.test/result?token=fictional#secret",
    capturedAt: "2026-11-10T00:00:00Z",
  };
  const result = await prepareReportImages([value], []);
  expect(result.images[0].source).toBe("https://example.test/result");
  expect(
    (await prepareReportImages([{ ...value, capturedAt: undefined }], []))
      .images,
  ).toHaveLength(0);
});
