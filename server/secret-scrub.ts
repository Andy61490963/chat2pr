import { redactDiscordToken } from "../shared/credentials.js";

/** 完全存取時交給工作容器的機密（資料庫密碼、連線字串）不能出現在紀錄、報告與錯誤訊息。 */
export const SCRUBBED = "[已遮蔽資料庫密碼]";

/** 傳回把機密換成固定字樣的函式；同時處理 JSON 跳脫後的寫法。太短的值不處理，避免誤傷一般文字。 */
export function scrubber(secrets: string[]) {
  const needles = [
    ...new Set(
      secrets.flatMap((s) => (s ? [s, JSON.stringify(s).slice(1, -1)] : [])),
    ),
  ]
    .filter((n) => n.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text: string) =>
    redactDiscordToken(needles.reduce((t, n) => t.split(n).join(SCRUBBED), text));
}

/** 遮蔽執行器回傳的整個結果（stdout、stderr、觀測事件）；沒有機密時原樣傳回。 */
export function scrubResult<T>(value: T, scrub: (text: string) => string): T {
  const raw = JSON.stringify(value);
  const cleaned = scrub(raw);
  return cleaned === raw ? value : (JSON.parse(cleaned) as T);
}

/** 檔案內容（base64）是否含有任一機密。 */
export function containsSecret(base64: string, secrets: string[]) {
  const text = Buffer.from(base64, "base64").toString("utf8");
  return redactDiscordToken(text) !== text || secrets.some((s) => s.length >= 4 && text.includes(s));
}
