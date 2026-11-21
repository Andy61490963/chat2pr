import {
  discordTokenProblem,
  normalizeDiscordApplicationId,
  normalizeDiscordToken,
} from "./discord-setup.js";

export const connectionSecretLabels = {
  lineSecret: "LINE Channel Secret",
  lineToken: "LINE Channel Access Token",
  discordToken: "Discord 機器人權杖",
  discordApplicationId: "Discord 應用程式 ID",
  openaiKey: "OpenAI API 金鑰",
} as const;

export type ConnectionSecretField = keyof typeof connectionSecretLabels;
export const connectionSecretFields = Object.keys(
  connectionSecretLabels,
) as ConnectionSecretField[];
export type ConnectionSecretPatch = Partial<
  Record<ConnectionSecretField, string | null>
>;
export type ConnectionSecretStatus = Record<
  ConnectionSecretField,
  { configured: boolean; updatedAt: string | null }
>;

export const secretReauthMessage =
  "連線金鑰尚未更新，因為 GitHub 登入已超過十分鐘。請重新登入後再輸入金鑰。";
export const secretReauthTarget = "settings-secrets";

export function removableConnectionSecret(field: ConnectionSecretField) {
  return field === "discordToken" || field === "discordApplicationId";
}

export function parseConnectionSecrets(
  input: unknown,
): { patch: ConnectionSecretPatch } | { error: string } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !Object.hasOwn(connectionSecretLabels, key),
    )
  )
    return {
      error:
        "連線金鑰尚未更新，因為送出了不支援的欄位。請重新整理設定頁後再試。",
    };
  const patch: ConnectionSecretPatch = {};
  for (const field of connectionSecretFields) {
    if (!Object.hasOwn(input, field)) continue;
    const raw = (input as Record<string, unknown>)[field];
    if (raw === null && removableConnectionSecret(field)) {
      patch[field] = null;
      continue;
    }
    const label = connectionSecretLabels[field];
    if (typeof raw !== "string" || raw.length > 4096)
      return {
        error: `無法儲存${label}，輸入格式不符。請重新複製完整資料後再貼上。`,
      };
    if (!raw.trim()) continue;
    const value =
      field === "discordToken"
        ? normalizeDiscordToken(raw)
        : field === "discordApplicationId"
          ? normalizeDiscordApplicationId(raw)
          : raw.trim();
    if (field === "discordToken") {
      const problem = discordTokenProblem(value);
      if (problem) return { error: problem };
    }
    if (field === "discordApplicationId" && !/^\d{17,20}$/.test(value))
      return {
        error:
          "無法儲存 Discord 應用程式 ID，格式不符。請從應用程式的一般資訊重新複製數字 ID。",
      };
    if (field === "lineSecret" && !/^[\da-f]{32}$/i.test(value))
      return {
        error:
          "無法儲存 LINE Channel Secret，格式不符。請到 LINE Developers 的「Basic settings」重新複製 Channel Secret。",
      };
    if (field === "lineToken" && !/^[\w+.\/=-]{20,}$/.test(value))
      return {
        error:
          "無法儲存 LINE Channel Access Token，格式不符。請到 LINE Developers 的「Messaging API」重新複製 Channel Access Token。",
      };
    if (field === "openaiKey" && !/^sk-[\w-]{16,}$/.test(value))
      return {
        error:
          "無法儲存 OpenAI API 金鑰，格式不符。請到 OpenAI 平台的 API 金鑰頁面建立並複製完整金鑰。",
      };
    patch[field] = value;
  }
  return { patch };
}
