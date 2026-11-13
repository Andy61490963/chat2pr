import { createHmac, timingSafeEqual } from "node:crypto";
import { sensitiveRepoPath } from "./repository-safety.js";
import { maskUnchangedLoginPresentation } from "./presentation-policy.js";
import type { Action, TaskStatus } from "../shared/types.js";
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function verifySignature(
  raw: Buffer,
  signature: string,
  secret: string,
  encoding: "base64" | "hex",
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const actual = Buffer.from(signature.replace(/^sha256=/, ""), encoding);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function batchDue(first: number, last: number, now: number) {
  return now - last >= 60000 || now - first >= 300000;
}
export function taipeiDay(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function classifyRisk(
  text: string,
  reasons: string[],
  paths: string[] = [],
  sensitive: string[] = [],
): string | null {
  if (reasons.length) return reasons.join("；");
  if (
    /(權限|認證|登入|付款|支付|刪除.{0,5}資料|刪資料|資料遷移|機密|部署|憑證|密碼|(?:身[分份]|角色).{0,4}(?:驗證|檢查)|authentication|authorization|payment|migration|secret|deploy|credential|drop\s+table|\b(?:cookies?|sessions?|csrf|jwt|oauth|password|permissions?|rbac|authn|authz)\b)/i.test(
      maskUnchangedLoginPresentation(text),
    )
  )
    return "涉及敏感功能，必須人工審核";
  if (paths.some((p) => sensitiveRepoPath(p, sensitive)))
    return "修改敏感路徑，必須人工審核";
  return null;
}
export const secretValueRisk = "要求輸出密碼、金鑰等機密的實際值，必須人工審核";
const secretNoun =
  "(?:密碼|金鑰|私鑰|權杖|連線字串|憑證|鹽值|雜湊值|token|secret|password|passwd|api[ _-]?key|connection ?string)";
const revealVerb =
  "(?:貼|給我|告訴我|列出|印出|輸出|顯示|提供|傳給|匯出|dump|print|show|reveal)";
const revealPatterns = [
  // 動詞後的機密名詞要是索取的對象（後面接句尾、「的值」或「給我／出來」），
  // 「列出 Token 過期的情境」這種名詞只是修飾語的不算。
  // 中間可以隔整個子句（例如「告訴我 某專案 連 設備平台 用的帳號密碼」），
  // 由後方的條件確認名詞是被索取的對象。
  new RegExp(
    `${revealVerb}[^。？?！!\\n]{0,60}?${secretNoun}(?=\\s*(?:的)?\\s*(?:實際|真實|完整)?(?:值|明文|內容)?\\s*(?:$|[，,。？?！!、；;]|給|出來|是多少|是什麼))`,
    "giu",
  ),
  new RegExp(
    `${secretNoun}\\s*(?:的)?\\s*(?:實際|真實|完整)?(?:值|明文|內容|是多少|是什麼(?=\\s*(?:$|[，,。？?！!]))|(?:都|也|全部|一起|直接)?\\s*(?:貼|印|輸出|列出|顯示|給))`,
    "giu",
  ),
];
/** AI 判讀明確寫出「要求揭露／輸出…機密」時也擋；「避免揭露」這類提醒不算。 */
const aiSecretRequest =
  /(?<!不|避免|勿|不得|不可)(?:要求|索取|請求|想要)\s*(?:揭露|輸出|提供|取得|貼出|告知|顯示|查看)/u;
/**
 * 查詢在隔離容器唯讀執行、回答會遮蔽機密，只有要求交出機密實際值時才需人工審核。
 * 「列出位置就好，不要貼出值」這類只問位置或機制的問法不算。
 */
export function queryRisk(text: string, aiRisks: string[] = []): string | null {
  if (aiRisks.some((r) => aiSecretRequest.test(r))) return secretValueRisk;
  for (const pattern of revealPatterns)
    for (const m of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, m.index - 6), m.index);
      const after = text.slice(
        m.index + m[0].length,
        m.index + m[0].length + 10,
      );
      if (
        /不要|不用|不必|別|勿|不可|不得|不能|避免|無須|無需|不需/.test(before)
      )
        continue;
      if (
        /^[^。？?！!\n]{0,10}?(?:位置|地方|檔案|哪裡|哪些檔|行號|路徑|在哪)/.test(
          after,
        )
      )
        continue;
      return secretValueRisk;
    }
  return null;
}
export function assertTransition(status: TaskStatus, action: Action) {
  const allowed: Record<Action, TaskStatus[]> = {
    approve: ["awaiting_approval"],
    reject: ["awaiting_approval"],
    cancel: [
      "awaiting_approval",
      "queued",
      "running",
      "reviewing",
      "budget_wait",
      "failed",
    ],
    retry: ["failed", "budget_wait"],
    amend: ["awaiting_approval", "queued", "failed", "budget_wait", "answered"],
    assumption: [
      "awaiting_approval",
      "queued",
      "failed",
      "budget_wait",
      "answered",
    ],
    assign: ["awaiting_approval", "queued", "failed", "budget_wait"],
    adopt: ["awaiting_approval"],
    mode: ["awaiting_approval", "queued", "failed", "budget_wait"],
    target: ["awaiting_approval", "queued", "failed", "budget_wait"],
    // 拒絕或取消後反悔：回到待審核重新確認，不會直接開始執行。
    reopen: ["rejected", "cancelled"],
  };
  if (!allowed[action].includes(status))
    throw new AppError(409, "任務狀態已改變，請重新整理");
}
export const redact = (value: string) =>
  value
    .replace(/sk-[\w-]{12,}/g, "[已遮蔽金鑰]")
    .replace(/(gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})/g, "[已遮蔽憑證]")
    .slice(0, 10000);
