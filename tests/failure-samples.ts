/**
 * 正式環境實際出現過的失敗輸出（#22），內容已改為虛構的套件與路徑。
 * Codex SDK 在對話失敗時直接丟出錯誤，Node 會把出錯位置與堆疊印在 stderr。
 */
export const codexSdkCrash = (reason: string) =>
  [
    "file:///opt/agentflow/node_modules/@openai/codex-sdk/dist/index.js:119",
    "      throw new Error(turnFailure.message);",
    "            ^",
    "",
    `Error: ${reason}`,
    "    at Thread.run (file:///opt/agentflow/node_modules/@openai/codex-sdk/dist/index.js:119:13)",
    "    at async file:///opt/agentflow/run.mjs:212:18",
    "",
    "Node.js v22.12.0",
  ].join("\n");

/** 正式環境看板上原樣出現的單行版本（換行已被壓掉，只剩堆疊開頭）。 */
export const codexSdkStackOnly =
  "file:///opt/agentflow/node_modules/@openai/codex-sdk/dist/index.js:119 throw new Error";
