import { describe, expect, it } from "vitest";
import { triageRememberedText } from "../server/group-replies.js";

describe("判讀說明的文字", () => {
  it("「已記住」回到群組前遮罩憑證格式", () => {
    const text = triageRememberedText(
      "測試專案的金鑰是 sk-fictional-key-000000000000",
    );
    expect(text).toContain("[已遮蔽金鑰]");
    expect(text).not.toContain("sk-fictional-key");
  });

  it("「已記住」以字元截到 100 字，不切壞表情符號", () => {
    const text = triageRememberedText("😀".repeat(150));
    const body = text.replace("已記住：", "");
    expect(Array.from(body)).toHaveLength(100);
    expect(body).toBe("😀".repeat(100));
  });
});
