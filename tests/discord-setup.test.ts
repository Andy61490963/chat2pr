import { describe, expect, it } from "vitest";
import {
  discordTokenProblem,
  normalizeDiscordToken,
} from "../shared/discord-setup.js";

// 虛構權杖：三段 base64url，以點分隔。
const token =
  "MTAwMDAwMDAwMDAwMDAwMDAwMA.Gabcde.fictional-token-value-for-tests_123";

describe("本機設定頁的 Discord 權杖", () => {
  it("去掉複製時多帶的空白、換行與 Bot 前綴後可以儲存", () => {
    for (const raw of [token, ` ${token} `, `${token}\n`, `Bot ${token}`])
      expect(discordTokenProblem(normalizeDiscordToken(raw))).toBeNull();
  });

  it("沒有點的內容（Client Secret、公開金鑰）指引到 Bot 頁重設權杖", () => {
    for (const raw of ["a".repeat(32), "4e86".repeat(16)])
      expect(discordTokenProblem(normalizeDiscordToken(raw))).toMatch(
        /不是機器人權杖.*Reset Token/,
      );
  });

  it("有點但缺段的內容視為格式不符", () => {
    expect(discordTokenProblem("abc.def")).toMatch(/格式不符/);
  });
});
