const discordBotToken =
  /(?<![\w-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}(?![\w-])/g;

export const redactDiscordToken = (text: string) =>
  text.replace(discordBotToken, "[已遮蔽 Discord 權杖]");

export const maskCredentials = (value: string) =>
  redactDiscordToken(value)
    .replace(/sk-[\w-]{12,}/g, "[已遮蔽金鑰]")
    .replace(/(gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})/g, "[已遮蔽憑證]");

export const redact = (value: string) => maskCredentials(value).slice(0, 10000);

/** 補問與專案資訊共用同一套拒收規則，避免把無法局部遮蔽的內容保存或送出。 */
export const containsCredential = (text: string) =>
  redact(text) !== text ||
  /(?:password|passwd|pwd|secret|token|api[_ -]?key|密碼|驗證碼|一次性密碼)\s*[=:：]\s*\S+|-----BEGIN [^-]*PRIVATE KEY-----|:\/\/[^\s/:]+:[^\s/@]+@|^\s*\d{6,8}\s*$/im.test(
    text,
  );
