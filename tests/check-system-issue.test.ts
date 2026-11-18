import { describe, expect, it } from "vitest";
import { AppError } from "../server/policy.js";
import {
  systemIssueOf,
  systemIssueOfSummary,
  systemIssuePrefix,
  systemIssueText,
  hostUnavailablePrefix,
} from "../shared/checks.js";

/**
 * 不需資料庫：「需要處理的系統問題」辨識規則。
 * 訊息直接用 check-environments.ts 丟出時用的共用常數，改訊息時這裡會一起失敗。
 */
const image = "line-agentflow-check:local";

describe("系統設定問題的辨識規則", () => {
  it.each([
    ["image_missing", systemIssueText.imageMissing(image)],
    ["image_outdated", systemIssueText.imageOutdated(image)],
    ["subnet_exhausted", systemIssueText.subnetExhausted],
    ["subnet_overlap", systemIssueText.subnetOverlap],
  ])("%s：執行器回 503 加固定訊息時為真，附處理方式", (kind, message) => {
    const issue = systemIssueOf(new AppError(503, message));
    expect(issue?.kind).toBe(kind);
    expect(issue?.fix).toMatch(
      kind.startsWith("image") ? /npm run deploy/ : /CHECK_SUBNET_POOL/,
    );
    // 看板從執行紀錄摘要讀回同一個問題。
    expect(systemIssueOfSummary(`${systemIssuePrefix}${message}`)?.kind).toBe(
      kind,
    );
  });
  it("自訂映像名稱也認得", () =>
    expect(
      systemIssueOf(
        new AppError(
          503,
          systemIssueText.imageOutdated("registry.fictional.test/check:v2"),
        ),
      )?.kind,
    ).toBe("image_outdated"));
  it.each([
    ["502 回應不完整", new AppError(502, "執行器回應不是完整的 JSON")],
    ["一般 503：啟動逾時", new AppError(503, "檢查環境啟動逾時")],
    ["一般 503：建立失敗", new AppError(503, "檢查環境建立失敗，請稍後再試")],
    ["500 SQL 錯誤", new AppError(500, "檢查 SQL 語法錯誤，請修正後試跑。")],
    [
      "訊息相同但不是 503",
      new AppError(500, systemIssueText.imageMissing(image)),
    ],
    ["沒有狀態碼的執行器連線失敗", new Error("執行器連線失敗（ECONNREFUSED）")],
  ])("%s：不是系統設定問題", (_, error) =>
    expect(systemIssueOf(error)).toBeNull(),
  );
  it("暫時性主機問題的摘要不會被當成系統設定問題", () => {
    expect(systemIssuePrefix).not.toBe(hostUnavailablePrefix);
    expect(
      systemIssueOfSummary(
        `${hostUnavailablePrefix}${systemIssueText.imageMissing(image)}`,
      ),
    ).toBeNull();
    expect(systemIssueOfSummary(null)).toBeNull();
  });
});
