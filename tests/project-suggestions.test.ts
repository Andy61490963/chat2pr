import { describe, expect, it } from "vitest";
import { rankProjectSuggestions } from "../server/project-suggestions.js";

const warehouse = {
  id: "warehouse",
  name: "範例庫存倉庫（主線）",
  repo: "example/StockCatalog",
  description: "庫存盤點與批號追蹤",
  config_version: 1,
  bound: false,
};
const reports = {
  ...warehouse,
  id: "reports",
  name: "範例報表",
  repo: "example/ReportBoard",
  description: "月報輸出",
  bound: true,
};

describe("未綁定專案建議", () => {
  it.each([
    "範例庫存倉庫",
    "範例庫存倉庫（主線）",
    "example/StockCatalog",
    "StockCatalog",
  ])("以專案名稱、別名或儲存庫找到建議並引用來源：%s", (name) => {
    const candidates = [warehouse, reports];
    expect(
      rankProjectSuggestions(
        [{ id: "m1", text: `請檢查 ${name} 的處理方式` }],
        candidates,
        candidates,
      ),
    ).toEqual([
      {
        projectId: warehouse.id,
        configVersion: 1,
        reason: "你的訊息提到了這個專案的名稱或儲存庫。",
        sourceIds: ["m1"],
      },
    ]);
  });

  it("比對專案說明與索引，按依據排序並最多建議兩個", () => {
    const indexOnly = {
      ...warehouse,
      id: "catalog",
      name: "範例目錄",
      repo: "example/catalog",
      description: "",
    };
    const other = {
      ...indexOnly,
      id: "other",
      name: "範例站台",
      repo: "example/other",
    };
    const candidates = [reports, warehouse, indexOnly, other];
    const suggestions = rankProjectSuggestions(
      [
        { id: "m1", text: "怎麼做庫存盤點？" },
        { id: "m2", text: "CatalogEntry 和 StockItem 如何關聯？" },
      ],
      candidates,
      candidates,
      [
        { project_id: indexOnly.id, source_id: "m2" },
        { project_id: other.id, source_id: "m2" },
      ],
    );
    expect(suggestions.map((s) => [s.projectId, s.sourceIds])).toEqual([
      [warehouse.id, ["m1"]],
      [indexOnly.id, ["m2"]],
    ]);
  });

  it("同樣的描述也命中已綁定的專案時，略過這項建議", () => {
    const candidates = [
      warehouse,
      { ...reports, description: warehouse.description },
    ];
    expect(
      rankProjectSuggestions(
        [{ id: "m1", text: "怎麼做庫存盤點？" }],
        candidates,
        candidates,
      ),
    ).toEqual([]);
  });
});
