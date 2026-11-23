import { readFile } from "node:fs/promises";
import type { Secrets } from "./config.js";
import { entryKind, type EntryKind } from "../shared/entry.js";

export type TunnelProvider = NonNullable<Secrets["tunnelProvider"]>;

export type TunnelPlan =
  | { provider: "ngrok"; hostname: string; authtoken: string }
  | {
      provider: "cloudflare";
      hostname: string;
      /** cloudflared 的參數；權杖一律走環境變數，不出現在程序列表。 */
      args: string[];
      env: Record<string, string>;
    }
  /** external：入口由自備程序維護；none：設定不完整，detail 說明缺什麼。 */
  | { provider: "external"; detail: string }
  | { provider: "none"; detail: string };

export const defaultMetricsPort = 4314;

/** cloudflared 的本機狀態連接埠；同一台主機另有 cloudflared 時可改用其他埠。 */
export function metricsPort(env = process.env) {
  const port = Number(env.CLOUDFLARED_METRICS_PORT ?? defaultMetricsPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("CLOUDFLARED_METRICS_PORT 必須是 1024–65535 的整數");
  return port;
}

/** 明確選擇優先；沒選時有 Cloudflare 憑證就用 Cloudflare，否則沿用 ngrok。 */
export function tunnelProvider(s: Secrets): TunnelProvider | undefined {
  if (s.tunnelProvider) return s.tunnelProvider;
  if (s.cloudflareTunnelToken || s.cloudflareConfig) return "cloudflare";
  if (s.ngrokToken) return "ngrok";
  return undefined;
}

export function tunnelPlan(s: Secrets, port = defaultMetricsPort): TunnelPlan {
  const provider = tunnelProvider(s);
  if (provider === "external")
    return { provider: "external", detail: "固定 HTTPS 入口由自備程序維護" };
  if (!provider || !s.publicUrl)
    return {
      provider: "none",
      detail: "尚未設定固定 HTTPS 入口的憑證與網址",
    };
  let url: URL;
  try {
    url = new URL(s.publicUrl);
  } catch {
    return { provider: "none", detail: "固定公開網址格式不正確" };
  }
  if (url.protocol !== "https:")
    return { provider: "none", detail: "固定入口必須使用 HTTPS" };
  if (provider === "ngrok")
    return s.ngrokToken
      ? { provider, hostname: url.hostname, authtoken: s.ngrokToken }
      : { provider: "none", detail: "已選擇 ngrok，但尚未填入 Authtoken" };
  const common = ["--no-autoupdate", "--metrics", `127.0.0.1:${port}`];
  if (s.cloudflareTunnelToken)
    return {
      provider,
      hostname: url.hostname,
      args: ["tunnel", ...common, "run"],
      env: { TUNNEL_TOKEN: s.cloudflareTunnelToken },
    };
  if (s.cloudflareConfig)
    return {
      provider,
      hostname: url.hostname,
      args: ["tunnel", "--config", s.cloudflareConfig, ...common, "run"],
      env: {},
    };
  return {
    provider: "none",
    detail: "已選擇 Cloudflare Tunnel，但尚未填入通道權杖或設定檔路徑",
  };
}

/**
 * 系統頁顯示的入口種類：設定優先；自備程序維護的入口從通道狀態檔（.local/tunnel-status.json）的說明辨識。
 * 讀不到狀態檔不算錯，只是認不出種類。
 */
export async function currentEntry(
  s: Secrets,
  statusFile: string,
): Promise<EntryKind> {
  let detail: string | undefined;
  try {
    const state = JSON.parse(await readFile(statusFile, "utf8")) as {
      detail?: unknown;
    };
    if (typeof state.detail === "string") detail = state.detail;
  } catch {
    // 通道尚未啟動或狀態檔正在改寫。
  }
  return entryKind(tunnelProvider(s), detail);
}

/** 通道程序每 30 秒寫一次狀態檔；超過這個時間沒更新就當成入口程序停了。 */
export const TUNNEL_STALE_MS = 180_000;

/**
 * 把 `tunnel-status.json` 的內容換成一次讀數（純函式）。text 為 null 代表沒有狀態檔。
 * 過期時不沿用檔案裡的說明：檔案最後寫的可能是「已連線」，看板會出現「異常：已連線」。
 */
export function tunnelReading(
  text: string | null,
  now = Date.now(),
): { ok: boolean; detail: string } {
  if (text === null) return { ok: false, detail: "尚未啟動 HTTPS 隧道" };
  let state: { ok?: unknown; detail?: unknown; checked_at?: unknown };
  try {
    state = JSON.parse(text);
  } catch {
    return { ok: false, detail: "通道狀態檔格式錯誤，請檢查維持入口的程序" };
  }
  const age = now - Date.parse(String(state.checked_at));
  if (!(age < TUNNEL_STALE_MS))
    return {
      ok: false,
      detail: Number.isFinite(age)
        ? `通道狀態檔已 ${Math.round(age / 60_000)} 分鐘沒有更新，維持入口的程序可能已停止`
        : "通道狀態檔沒有檢查時間，請檢查維持入口的程序",
    };
  return state.ok
    ? { ok: true, detail: "固定 HTTPS 入口已連線" }
    : { ok: false, detail: String(state.detail ?? "HTTPS 入口異常") };
}
