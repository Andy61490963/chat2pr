import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../docs/rag-flow-demo.html", import.meta.url), "utf8");

describe("RAG 流程驗收展示頁", () => {
  it("文件標題與唯一主標題符合需求", () => {
    expect(html.match(/<title>(.*?)<\/title>/)?.[1]).toBe("RAG 流程驗收");
    expect([...html.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/g)].map((match) => match[1])).toEqual(["RAG 流程驗收"]);
  });

  it("檢索說明包含完整的參考來源", () => {
    const retrieval = [...html.matchAll(/<li>(.*?)<\/li>/g)].find((match) => match[1].includes("<h2>檢索</h2>"));
    expect(retrieval?.[1]).toContain("可參考同群組歷史討論、專案檔案與過往任務結果。");
  });

  it("頁尾保留原有說明並另行呈現正式群組來源追溯文案", () => {
    const footer = html.match(/<footer>(.*?)<\/footer>/)?.[1];
    expect(footer).toContain("靜態流程展示・過往經驗僅供參考，執行以本次核准需求為準。");
    expect(footer).toContain("<div>正式群組可追溯需求來源，PR 完成後由管理者確認合併。</div>");
  });

  it("依序呈現五個步驟，每一步皆有繁體中文說明", () => {
    expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1])).toEqual(["收訊", "檢索", "開發", "審查", "PR"]);
    const steps = [...html.matchAll(/<li>(.*?)<\/li>/g)];
    expect(steps).toHaveLength(5);
    for (const step of steps) expect(step[1]).toMatch(/<p>[\u4e00-\u9fff][^<]+。<\/p>/);
  });
});
