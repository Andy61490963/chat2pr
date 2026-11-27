interface FailureSignature {
  number: number;
  step: string;
  cause: string;
  issue: number;
}

const confirmed: readonly FailureSignature[] = [
  { number: 13, step: "步驟：任務 進入 failed：看板缺少本次失敗原因", cause: "最近稽核：error 設定問題（Codex 修改程式階段）：訂閱上游回應失敗（上游 HTTP 400）。", issue: 297 },
];

export function classifyFlowFailure(number: number, detail: string, signatures = confirmed) {
  const lines = detail.split("\n");
  if (lines.some(line => line === "輸出含虛構憑證" || /^有 \d+ 個任務|^有 \d+ 則過期通知|^有 \d+ 個工作資源|未確認清除|未確認關閉/.test(line))) return;
  const step = lines[0].replace(/^步驟：任務 [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12} 進入 /, "步驟：任務 進入 ");
  return signatures.find(entry => entry.number === number && step === entry.step && lines.includes(entry.cause))?.issue;
}
