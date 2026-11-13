import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { AppError } from "./policy.js";

/**
 * 定期檢查的 HTTP／TCP 探測，只在主機執行器上執行（可以連到公司內網的設備）。
 * 拒絕本機回環、主機內部名稱與雲端中繼資料等位址，避免被用來探測 chat2pr 自己的服務。
 */

const blockedNames =
  /^(localhost|host\.docker\.internal|gateway\.docker\.internal|metadata(\.google\.internal)?)$/i;

function blockedAddress(address: string): boolean {
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

export async function httpProbe(url: string, contains?: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError(422, "網址格式不正確");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new AppError(422, "只能使用不含帳密的 http 或 https 網址");
  await safeHost(u.hostname);
  const started = Date.now();
  try {
    const response = await fetch(u, {
      method: "GET",
      // 不跟隨轉址：轉到別的網域可能繞過位址限制。
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const body = contains ? (await response.text()).slice(0, 200000) : "";
    const ok =
      response.status >= 200 &&
      response.status < 300 &&
      (!contains || body.includes(contains));
    return {
      ok,
      status: response.status,
      ms: Date.now() - started,
      ...(contains && response.status < 300 && !body.includes(contains)
        ? { missing: true }
        : {}),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: (e as Error).name === "TimeoutError" ? "逾時" : "連不上",
    };
  }
}

export async function tcpProbe(host: string, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError(422, "連接埠不正確");
  const address = await safeHost(host);
  const started = Date.now();
  return new Promise<{ ok: boolean; ms: number }>((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started });
    };
    socket.setTimeout(5000, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, address, () => done(true));
  });
}
