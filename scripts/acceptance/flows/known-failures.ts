interface FailureSignature {
  number: number;
  step: string;
  cause: string;
  issue: number;
}

const transient = "最近稽核：error 暫時性問題（Codex 修改程式階段）：AI 服務回應中斷或逾時（已自動重試一次，仍然失敗）。";
const confirmed: readonly FailureSignature[] = [
  { number: 10, step: "步驟：任務 進入 failed：看板缺少本次失敗原因", cause: "最近稽核：error 專案問題（執行測試階段）：還沒修改前，目標分支本身就建置或測試失敗。", issue: 266 },
  { number: 12, step: "步驟：任務 進入 queued：預期 queued，任務已成為 failed", cause: transient, issue: 264 },
  { number: 13, step: "步驟：任務 進入 failed：永久錯誤仍被重試", cause: transient, issue: 264 },
];

export function classifyFlowFailure(number: number, detail: string, signatures = confirmed) {
  const lines = detail.split("\n");
  if (lines.some(line => line === "輸出含虛構憑證" || /^有 \d+ 個任務|^有 \d+ 則過期通知|^有 \d+ 個工作資源|未確認清除|未確認關閉/.test(line))) return;
  const step = lines[0].replace(/^步驟：任務 [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12} 進入 /, "步驟：任務 進入 ");
  return signatures.find(entry => entry.number === number && step === entry.step && lines.includes(entry.cause))?.issue;
}
