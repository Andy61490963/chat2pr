import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryKind, entryText } from "../shared/entry.js";
import { currentEntry } from "../server/tunnel-provider.js";

describe("固定 HTTPS 入口的種類", () => {
  it("設定了 Cloudflare 或 ngrok 時照設定顯示，不看狀態檔", () => {
    expect(entryKind("cloudflare", "ngrok 已連線")).toBe("cloudflare");
    expect(entryKind("ngrok", "Cloudflare 已連線")).toBe("ngrok");
    expect(entryText.cloudflare.title).toBe(
      "Cloudflare Tunnel 固定 HTTPS 入口",
    );
    expect(entryText.ngrok.title).toBe("ngrok 固定 HTTPS 入口");
  });
  it("自備入口從狀態檔辨識；認不出來就寫自備程序", () => {
    expect(entryKind("external", "Cloudflare 固定 HTTPS 入口已連線")).toBe(
      "cloudflare",
    );
    expect(entryKind("external", "固定 HTTPS 入口由自備程序維護")).toBe(
      "external",
    );
    expect(entryText.external.title).toBe("固定 HTTPS 入口（自備程序）");
  });
  it("沒有設定也沒有狀態時不假裝是 ngrok", () => {
    expect(entryKind(undefined, undefined)).toBe("unknown");
    expect(entryText.unknown.title).toBe(
      "固定 HTTPS 入口（Cloudflare 或 ngrok）",
    );
    for (const kind of ["cloudflare", "external", "unknown"] as const)
      expect(entryText[kind].title).not.toMatch(/^ngrok/);
  });
});

describe("系統頁讀取入口種類", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const statusFile = (detail?: string) => {
    dir = mkdtempSync(join(tmpdir(), "entry-"));
    const file = join(dir, "tunnel-status.json");
    if (detail !== undefined)
      writeFileSync(
        file,
        JSON.stringify({ ok: true, detail, checked_at: "2026-01-01" }),
      );
    return file;
  };
  it("正式環境的自備 Cloudflare 程序：secrets 沒設定，從狀態檔認出", async () => {
    await expect(
      currentEntry({}, statusFile("Cloudflare 固定 HTTPS 入口已連線")),
    ).resolves.toBe("cloudflare");
  });
  it("有 ngrok 憑證時是 ngrok；選了自備入口而狀態檔不存在時是自備程序", async () => {
    await expect(
      currentEntry({ ngrokToken: "虛構權杖" }, statusFile()),
    ).resolves.toBe("ngrok");
    await expect(
      currentEntry({ tunnelProvider: "external" }, statusFile()),
    ).resolves.toBe("external");
  });
});
