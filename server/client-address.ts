import { readFileSync } from "node:fs";
import { isIP } from "node:net";

const plain = (address: string) => address.replace(/^::ffff:/i, "");

/** 容器的預設閘道。主機連接埠轉進來的連線在容器內都從這個位址出現。 */
function defaultGateway() {
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n")) {
      const [, destination, gateway] = line.split("\t");
      if (destination !== "00000000" || !/^[0-9A-F]{8}$/i.test(gateway ?? ""))
        continue;
      // 核心以位元組反序的十六進位記錄位址。
      return gateway
        .match(/../g)!
        .reverse()
        .map((byte) => parseInt(byte, 16))
        .join(".");
    }
  } catch {
    // 不是 Linux 或讀不到路由表：只認本機。
  }
  return null;
}

// 服務只在主機的本機連接埠收連線，外部流量都由通道轉進來，
// 所以只有本機與容器閘道這一跳會如實回報用戶端位址。
// 工作容器等其他內部來源不在此列，它們帶的轉送標頭一律不看。
const tunnelHops = new Set(
  ["127.0.0.1", "::1", defaultGateway()].filter(Boolean),
);

/**
 * 流量限制用來區分用戶端的位址。
 * 通道會把它看到的用戶端位址接在 X-Forwarded-For 最後面；前面幾段是用戶端自己能填的，不採信。
 */
export function clientAddress(
  peer: string,
  forwarded: string | string[] | undefined,
) {
  const from = plain(peer);
  if (!tunnelHops.has(from)) return from;
  const last = plain(
    String(forwarded ?? "")
      .split(",")
      .pop()!
      .trim(),
  );
  return isIP(last) ? last : from;
}
