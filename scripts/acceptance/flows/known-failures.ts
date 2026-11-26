interface FailureSignature {
  number: number;
  step: string;
  cause: string;
  issue: number;
}

const confirmed: readonly FailureSignature[] = [];

export function classifyFlowFailure(number: number, detail: string, signatures = confirmed) {
  const lines = detail.split("\n");
  if (lines.some(line => line === "輸出含虛構憑證" || /^有 \d+ 個任務|^有 \d+ 則過期通知|^有 \d+ 個工作資源|未確認清除|未確認關閉/.test(line))) return;
  return signatures.find(entry => entry.number === number && lines[0] === entry.step && lines.includes(entry.cause))?.issue;
}
