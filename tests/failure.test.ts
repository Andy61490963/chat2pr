import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureNotice,
  groupFailureText,
  keyErrorLines,
  stripInternals,
} from "../server/failure.js";
import { codexSdkCrash, codexSdkStackOnly } from "./failure-samples.js";

// 正式環境近 30 天看得到、但使用者看不懂的失敗訊息（#22），各自固定分類與白話說明。
describe("實際錯誤樣本的分類", () => {
  it("系統套件（#18）：來源被白名單擋下或計畫不再通過固定規則是設定問題，其他安裝失敗是環境問題", () => {
    for (const raw of [
      "系統套件安裝失敗（退出碼 100）：Err:1 https://deb.debian.org/debian bookworm InRelease\n  403  Forbidden [IP: 172.18.0.2 3128]",
      "安裝項目 mssql-tools18 未通過固定規則：來源 packages.microsoft.com 不在白名單",
      "下載來源白名單無效：10.0.0.1：不可填 IP 位址",
    ]) {
      const f = classifyFailure(raw, "install");
      expect(f.category).toBe("config");
      expect(f.action).toContain("下載來源白名單");
    }
    const failed = classifyFailure(
      "系統套件安裝失敗（退出碼 100）：E: Unable to locate package fictional-tool",
      "install",
    );
    expect(failed.category).toBe("environment");
    expect(failed.plain).toBe("安裝前審查放行的系統套件沒有裝起來");
    expect(failed.detail).toContain("Unable to locate package");
    expect(classifyFailure("衍生映像設定異常，已刪除，請回報").category).toBe(
      "environment",
    );
    expect(
      classifyFailure("AI 安裝審查失敗：stream disconnected", "install")
        .category,
    ).toBe("transient");
    expect(
      classifyFailure("安裝審查超過單次預估上限", "install").category,
    ).toBe("config");
  });

  it("安裝失敗但沒有任何輸出：環境問題，說明工具沒留下訊息", () => {
    const f = classifyFailure("安裝失敗：", "install");
    expect(f.category).toBe("environment");
    expect(f.plain).toContain("安裝依賴失敗");
    expect(f.detail).toBe("");
    expect(failureNotice(f, true, "安裝依賴")).toContain(
      "工具沒有留下錯誤訊息，完整輸出見執行紀錄",
    );
  });

  it("Codex SDK 的堆疊：暫時性的 AI 服務中斷，摘要不含堆疊", () => {
    for (const raw of [
      `Codex 執行失敗：${codexSdkStackOnly}`,
      `Codex 執行失敗：${codexSdkCrash("stream disconnected before completion")}`,
    ]) {
      const f = classifyFailure(raw, "code");
      expect(f.category).toBe("transient");
      expect(f.plain).toBe("AI 服務回應中斷或逾時");
      const text = failureNotice(f, true, "Codex 修改程式");
      expect(text).not.toMatch(
        /file:\/\/|\/opt\/agentflow|throw new Error|\bat /,
      );
    }
    expect(
      classifyFailure(
        `Codex 執行失敗：${codexSdkCrash("stream disconnected before completion")}`,
        "code",
      ).detail,
    ).toBe("Error: stream disconnected before completion");
  });

  it("工作輸入不是完整的 JSON：執行器傳送中斷，屬暫時性", () => {
    const f = classifyFailure(
      `Codex 執行失敗：${'file:///opt/agentflow/run.mjs:25\n  throw new Error("工作輸入不是完整的 JSON，已停止執行");\n  ^\n\nError: 工作輸入不是完整的 JSON，已停止執行\n    at file:///opt/agentflow/run.mjs:25:9'}`,
      "code",
    );
    expect(f.category).toBe("transient");
    expect(f.detail).toBe("Error: 工作輸入不是完整的 JSON，已停止執行");
  });

  it("執行器連線失敗（UND_ERR_HEADERS_TIMEOUT）與 fetch failed：暫時性", () => {
    const runner = classifyFailure(
      "執行器連線失敗（UND_ERR_HEADERS_TIMEOUT）；請檢查執行器、網路及逾時紀錄",
      "code",
    );
    expect(runner.category).toBe("transient");
    expect(runner.plain).toBe("和執行器的連線中斷或逾時");
    const fetch = classifyFailure("fetch failed", "publish");
    expect(fetch.category).toBe("transient");
    expect(fetch.plain).toContain("網路連線中斷");
  });
});

describe("其他分類", () => {
  it.each([
    ["目標分支基底驗證失敗：error CS1002: ; expected", "test", "project"],
    ["一次自動修復後仍未通過驗證：按鈕仍是藍色", "verify", "project"],
    ["任務超過 30 分鐘限制", "code", "project"],
    ["執行超過時間限制", "code", "project"],
    [
      "命令沒有找到可執行的測試，不能標示為測試通過；請檢查測試範圍",
      "test",
      "project",
    ],
    [
      "測試環境問題（不是程式沒過）：容器內的 SQL Server 沒有啟動成功。",
      "test",
      "environment",
    ],
    ["安裝失敗：sh: 1: dotnet: not found", "install", "environment"],
    ["Codex 執行失敗：本機代理回應 429", "code", "config"],
    ["HttpError: Bad credentials", "publish", "config"],
    ["任務已取消、暫停或需求版本已改變", "code", "config"],
    ["建置設定 README.md 過大，請使用進階設定", "starting", "system"],
    ["上游回應 503 Service Unavailable", "review", "transient"],
    // 測試輸出裡的連線錯誤是專案問題，不能當成網路問題重試。
    [
      "目標分支基底驗證失敗：Npgsql.NpgsqlException: ECONNREFUSED 127.0.0.1:5432",
      "test",
      "project",
    ],
    // 套件來源暫時不通：安裝階段也算暫時性。
    ["安裝失敗：npm ERR! code ETIMEDOUT", "install", "transient"],
  ])("%s → %s 階段 → %s", (raw, phase, category) => {
    expect(classifyFailure(raw, phase).category).toBe(category);
  });
});

describe("錯誤重點與遮蔽", () => {
  it("合併輸出中取最後幾行有意義的錯誤", () => {
    const output = [
      "npm warn deprecated left-pad@1.0.0",
      "npm ERR! code E404",
      "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@contoso%2fmissing",
      "npm ERR! A complete log of this run can be found in: /tmp/home/.npm/_logs/debug.log",
    ].join("\n");
    expect(keyErrorLines(output, 2)).toBe(
      [
        "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@contoso%2fmissing",
        "npm ERR! A complete log of this run can be found in: /tmp/home/.npm/_logs/debug.log",
      ].join("\n"),
    );
    expect(keyErrorLines("ERROR: failed to solve: missing base image")).toBe(
      "ERROR: failed to solve: missing base image",
    );
  });

  it("沒有明顯錯誤行時取最後兩行", () => {
    expect(keyErrorLines("步驟一\n步驟二\n步驟三")).toBe("步驟二\n步驟三");
  });

  it("去除堆疊與內部路徑，機密照樣遮蔽", () => {
    expect(stripInternals(codexSdkCrash("unexpected status 500"))).toBe(
      "Error: unexpected status 500",
    );
    const f = classifyFailure(
      "Codex 執行失敗：Error: request failed with key sk-test-fictional-000000000000",
      "code",
    );
    expect(f.detail).toContain("[已遮蔽金鑰]");
    expect(f.detail).not.toContain("sk-test-fictional");
  });
});

describe("群組訊息", () => {
  it("只用固定的白話句子，不含原始錯誤、堆疊或內部路徑", () => {
    const samples: [string, string][] = [
      [`Codex 執行失敗：${codexSdkCrash("stream disconnected")}`, "code"],
      ["安裝失敗：/workspace/src/App.csproj : error NU1101: x", "install"],
      ["fetch failed", "publish"],
      ["TypeError: Cannot read properties of undefined (reading 'x')", "code"],
    ];
    for (const [raw, phase] of samples) {
      const text = groupFailureText(classifyFailure(raw, phase), true);
      expect(text).not.toMatch(
        /file:\/\/|\/opt\/|\/workspace|NU1101|TypeError|\bat /,
      );
      expect(text).toMatch(/到看板按「重試」|請管理者/);
      expect(text).toContain("系統已自動重試一次");
    }
  });
});
