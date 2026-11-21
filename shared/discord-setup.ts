/**
 * 本機設定頁的 Discord 權杖檢查。複製時常多帶空白或換行，也常誤貼成 OAuth2 的 Client Secret 或公開金鑰，
 * 這裡先整理再判斷，錯誤訊息指出要去哪裡拿正確的值。
 */
export function normalizeDiscordToken(raw: string) {
  return raw.trim().replace(/^Bot\s+/i, "");
}

export function discordTokenProblem(token: string): string | null {
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(token))
    return null;
  if (!token.includes("."))
    return "無法儲存 Discord 權杖：貼上的內容不是機器人權杖，可能是 OAuth2 的 Client Secret 或公開金鑰。請到 Discord 開發者入口左側的「Bot」頁按 Reset Token，複製新權杖後再貼上。";
  return "無法儲存 Discord 權杖，格式不符。請到 Discord 開發者入口左側的「Bot」頁按 Reset Token，完整複製新權杖後再貼上。";
}

export function normalizeDiscordApplicationId(raw: string) {
  return raw.trim();
}
