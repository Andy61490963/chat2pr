/**
 * 固定 HTTPS 入口的種類。系統頁架構圖與流程說明依實際設定顯示，不寫死某一種通道。
 * unknown：沒有設定入口種類、狀態檔也看不出來（例如尚未啟動通道）。
 */
export type EntryKind = "cloudflare" | "ngrok" | "external" | "unknown";

/**
 * 先看設定的入口種類（secrets 的 tunnelProvider，或依憑證推得的結果）；
 * 自備程序維護的入口（external 或沒有設定）再從通道狀態檔的說明辨識，正式環境的自備 Cloudflare 程序就是這樣。
 */
export function entryKind(
  provider: string | undefined,
  statusDetail: string | undefined,
): EntryKind {
  if (provider === "cloudflare" || provider === "ngrok") return provider;
  if (/cloudflare/i.test(statusDetail ?? "")) return "cloudflare";
  if (/ngrok/i.test(statusDetail ?? "")) return "ngrok";
  return provider === "external" ? "external" : "unknown";
}

/** name：句中提到入口時用；title：架構圖方框標題。 */
export const entryText: Record<EntryKind, { name: string; title: string }> = {
  cloudflare: {
    name: "Cloudflare Tunnel 固定 HTTPS 入口",
    title: "Cloudflare Tunnel 固定 HTTPS 入口",
  },
  ngrok: { name: "ngrok 固定 HTTPS 入口", title: "ngrok 固定 HTTPS 入口" },
  external: {
    name: "自備的固定 HTTPS 入口",
    title: "固定 HTTPS 入口（自備程序）",
  },
  unknown: {
    name: "固定 HTTPS 入口",
    title: "固定 HTTPS 入口（Cloudflare 或 ngrok）",
  },
};
