const MASK = "[已遮蔽]";

const discordBotToken =
  /(?<![\w-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}(?![\w-])/g;

export const redactDiscordToken = (text: string) =>
  text.replace(discordBotToken, "[已遮蔽 Discord 權杖]");

// 任何協定的網址（postgres、mysql、mongodb+srv、redis、amqp…）都從「://」認起，不看協定名稱：
// 協定前面緊接其他文字也認得到，也不必為協定回溯。授權區段在函式裡拆，不靠回溯。
const urlAuthority = /:\/\/([^\s/?#"'<>\\]*)/g;
// 沒有冒號的使用者資訊：短的一般帳號（git、deploy）保留，長的多半是權杖。
const plainUser = /^[A-Za-z0-9._-]{1,32}$/;

/** 帳號保留、密碼遮蔽；只有使用者資訊時，看起來像權杖就整段遮蔽。主機、埠與資料庫不動。 */
function maskUrlUserinfo(all: string, authority: string) {
  const at = authority.lastIndexOf("@");
  if (at < 0) return all;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  const kept =
    colon >= 0
      ? `${userinfo.slice(0, colon)}:${MASK}`
      : plainUser.test(userinfo)
        ? userinfo
        : MASK;
  return `://${kept}@${authority.slice(at + 1)}`;
}

// 值的寫法：引號（含 JSON 跳脫後的引號）、ODBC 大括號、ADO.NET 到分號為止（可含空白，最多 200 字），
// 其餘到空白或分隔符號為止。每個分支都有界或不回溯。
const value = String.raw`(\\?"(?:[^"\\\n]|\\[^"\n])*\\?"|'[^'\n]*'|\{[^}\n]*\}|[^;\n"'=]{1,200}(?=;)|[^;\s"',}&]+)`;
const secretKeys = String.raw`password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|(?:access|refresh|id|auth|api|bearer|session)[_-]?token`;
// 「key=值」是連線字串與查詢參數的寫法，單獨的 token、auth 也算。「key: 值」常是一般文字
//（Unexpected token: '<'、auth: 用 OAuth 登入）：單獨的 token 不算，auth 只認 JSON 的 "auth":。
const keyEquals = new RegExp(
  String.raw`(?<![A-Za-z0-9])((?:${secretKeys}|token|auth)\\?["']?\s*=\s*)${value}`,
  "gi",
);
const keyColon = new RegExp(
  String.raw`(?<![A-Za-z0-9])((?:${secretKeys}|(?<=["'])auth(?=\\?["']))\\?["']?\s*:\s*)${value}`,
  "gi",
);
/** 引號包住的值保留引號，JSON 仍是合法的 JSON。 */
const maskValue = (_all: string, key: string, raw: string) => {
  const quote = raw.match(/^(\\?["'])/)?.[1];
  return `${key}${quote ? `${quote}${MASK}${quote}` : MASK}`;
};

const tokenPatterns: [RegExp, string][] = [
  [
    /-----BEGIN [^\n]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [^\n]{0,40}PRIVATE KEY-----|[\s\S]*)/g,
    "[已遮蔽私鑰]",
  ],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[已遮蔽權杖]"],
  [/sk-[\w-]{12,}/g, "[已遮蔽金鑰]"],
  [/(gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})/g, "[已遮蔽憑證]"],
  [/\bglpat-[\w-]{20,}/g, "[已遮蔽憑證]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[已遮蔽權杖]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[已遮蔽金鑰]"],
  [/\bAIza[\w-]{35}/g, "[已遮蔽金鑰]"],
];

/**
 * 所有對外出口（看板、群組、通知、稽核、執行紀錄、AI 提示）共用的帳密遮蔽。
 * 涵蓋任何協定網址裡的密碼、連線字串與設定檔的密碼欄位、常見權杖格式；帳號、主機與資料庫保留，
 * 讓人看得出連到哪裡。可以重複套用，結果不變。公開識別碼（例如 Discord 應用程式 ID）不遮。
 */
export const maskCredentials = (text: string) =>
  tokenPatterns
    .reduce((t, [pattern, label]) => t.replace(pattern, label), redactDiscordToken(text))
    // 憑證至少 8 個字而且含數字或符號；「使用 Bearer token 呼叫」「Authorization: Bearer …」這類
    // 純英文單字或佔位符是說明文字，不遮，查詢回答與 PR 說明才讀得懂（正式環境 68 則回答中有 2 則曾被誤遮）。
    .replace(/\b(Authorization\s*[:=]\s*)(?:(Bearer|Basic|Token|Digest)\s+)?(?=[A-Za-z]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi, (_a, k: string, scheme?: string) => `${k}${scheme ? `${scheme} ` : ""}${MASK}`)
    .replace(/\bBearer\s+(?=[A-Za-z]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`)
    .replace(urlAuthority, maskUrlUserinfo)
    .replace(keyEquals, maskValue)
    .replace(keyColon, maskValue);

export const redact = (value: string) => maskCredentials(value).slice(0, 10000);

/** 補問與專案資訊共用同一套拒收規則，避免把無法局部遮蔽的內容保存或送出。 */
export const containsCredential = (text: string) =>
  redact(text) !== text ||
  /(?:password|passwd|pwd|secret|token|api[_ -]?key|密碼|驗證碼|一次性密碼)\s*[=:：]\s*\S+|-----BEGIN [^-]*PRIVATE KEY-----|:\/\/[^\s/:]+:[^\s/@]+@|^\s*\d{6,8}\s*$/im.test(
    text,
  );
