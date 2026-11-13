/** 必要資訊只問一件事；常見答案是提示，不代表核准或替使用者作答。 */
export interface ClarificationQuestion {
  text: string;
  choices: string[];
}

export function assumptionBlock(assumptions: string[]) {
  return assumptions.length
    ? `\n\n假設：\n${assumptions.map((a) => `- ${a}`).join("\n")}`
    : "";
}

/** 摘要中的假設由系統統一附加，修改單一假設時不重寫其餘需求。 */
export function withAssumptions(
  summary: string,
  assumptions: string[],
  previous: string[] = [],
) {
  const old = assumptionBlock(previous);
  const body =
    old && summary.endsWith(old) ? summary.slice(0, -old.length) : summary;
  return body.trimEnd() + assumptionBlock(assumptions);
}
