import type { Secrets } from "./config.js";

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
