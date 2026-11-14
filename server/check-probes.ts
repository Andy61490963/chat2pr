import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import { AppError } from "./policy.js";

/**
 * 定期檢查的 HTTP／TCP 探測（#19 起在該檢查的專用檢查容器內執行）。
 * 主機執行器建立環境前先以 safeHost 拒絕本機回環、主機內部名稱與雲端中繼資料等位址；
 * 轉接器每次連線時再核對一次解析結果，避免 DNS 改指向後繞過限制。
 */

const blockedNames =
  /^(localhost|host\.docker\.internal|gateway\.docker\.internal|metadata(\.google\.internal)?)$/i;

export function blockedAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === "::1" || a === "::" || a.startsWith("fe80:")) return true;
    const v4 = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return v4 ? blockedAddress(v4[1]) : false;
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224 // 回環、未指定、連結本地與中繼資料、多播
  );
}

/** 解析主機並確認不是被拒絕的位址；回傳實際要連的 IP。 */
export async function safeHost(host: string) {
  const name = host.replace(/^\[|\]$/g, "");
  if (!name || blockedNames.test(name))
    throw new AppError(422, "這個位址不能用於定期檢查");
  const address = isIP(name) ? name : (await lookup(name)).address;
  if (blockedAddress(address))
    throw new AppError(422, "這個位址不能用於定期檢查");
  return address;
}

/** HTTP 檢查的網址：只接受不含帳密的 http／https。 */
export function httpTarget(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError(422, "網址格式不正確");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new AppError(422, "只能使用不含帳密的 http 或 https 網址");
  return u;
}

/** 網址實際連線的主機與連接埠（轉接器的目標）。 */
export function httpEndpoint(url: string) {
  const u = httpTarget(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
  };
}

export interface HttpProbeResult {
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
  missing?: boolean;
}

/**
 * 經轉接器送出 GET：連線對象是轉接器，Host 標頭與憑證核對仍用原網址的主機。
 * 不跟隨轉址：轉到別的網域可能繞過位址限制（轉接器也只通到原本的主機）。
 */
export function httpProbeVia(
  url: string,
  contains: string | undefined,
  via: { host: string; port: number },
): Promise<HttpProbeResult> {
  const u = httpTarget(url);
  const name = u.hostname.replace(/^\[|\]$/g, "");
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Omit<HttpProbeResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ...r, ms: Date.now() - started });
    };
    const options: https.RequestOptions = {
      host: via.host,
      port: via.port,
      method: "GET",
      path: `${u.pathname}${u.search}`,
      headers: { Host: u.host, "User-Agent": "chat2pr-check" },
      agent: false,
    };
    const req =
      u.protocol === "https:"
        ? https.request({
            ...options,
            ...(isIP(name) ? {} : { servername: name }),
            checkServerIdentity: (_host, cert) =>
              checkServerIdentity(name, cert),
          })
        : http.request(options);
    const timer = setTimeout(
      () => finish({ ok: false, status: 0, error: "逾時" }),
      10000,
    );
    req.on("error", () => finish({ ok: false, status: 0, error: "連不上" }));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const good = status >= 200 && status < 300;
      if (!contains || !good) {
        res.resume();
        return finish({ ok: good, status });
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length >= 200000 || body.includes(contains)) {
          const found = body.includes(contains);
          finish({ ok: found, status, ...(found ? {} : { missing: true }) });
        }
      });
      res.on("end", () => {
        const found = body.includes(contains);
        finish({ ok: found, status, ...(found ? {} : { missing: true }) });
      });
      res.on("error", () => finish({ ok: false, status: 0, error: "連不上" }));
    });
    req.end();
  });
}

/**
 * TCP 檢查：轉接器以「回報模式」執行，收到連線就去連目標，成功回 1、失敗回 0。
 * 只連到轉接器本身不能算成功（轉接器一定接受連線）。
 */
export function tcpProbeVia(via: {
  host: string;
  port: number;
}): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started });
    };
    socket.setTimeout(8000, () => done(false));
    socket.once("error", () => done(false));
    socket.once("data", (b: Buffer) => done(b[0] === 0x31));
    socket.once("end", () => done(false));
    socket.connect(via.port, via.host);
  });
}
