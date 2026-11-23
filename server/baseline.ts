import { describeTestFailures, parseTestFailures } from "./test-failures.js";

/**
 * 目標分支基底驗證失敗時的說明（#248）：哪些測試失敗、各自的第一段錯誤訊息。
 * 認不出測試格式時回傳空字串，失敗說明照舊只挑輸出的錯誤行。
 */
export function baselineReport(output: string) {
  const failures = parseTestFailures(output);
  return failures ? describeTestFailures(failures) : "";
}
