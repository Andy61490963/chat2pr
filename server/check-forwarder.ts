import { lookup } from "node:dns/promises";
import { createServer, isIP, Socket } from "node:net";
import { blockedAddress } from "./check-probes.js";

/**
 * 定期檢查的轉接器（#19），在檢查映像內以 `node /opt/check/forwarder.mjs` 執行。
 * 同時接上該檢查的專用內部網路與對外網路，只把一個固定連接埠轉到唯一的目標 主機:連接埠。
 * 不持有任何連線機密；目標由主機執行器在建立時以環境變數指定，執行中不能更改。
 *
 * MODE=pipe：雙向轉送（SQL、HTTP）。
 * MODE=report：TCP 檢查用，收到連線就去連目標，成功回 "1"、失敗回 "0" 後關閉。
 */

const targetHost = process.env.TARGET_HOST ?? "";
const targetPort = Number(process.env.TARGET_PORT);
const mode = process.env.MODE === "report" ? "report" : "pipe";
const listenPort = Number(process.env.LISTEN_PORT ?? 7000);
const maxConnections = 16;

if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1) {
  console.error("轉接器缺少目標");
  process.exit(2);
}

/** 每次連線都重新解析並核對，避免名稱改指向回環或中繼資料位址。 */
async function resolveTarget() {
  const name = targetHost.replace(/^\[|\]$/g, "");
  const address = isIP(name) ? name : (await lookup(name)).address;
  if (blockedAddress(address)) throw new Error("blocked");
  return address;
}

function upstream(timeoutMs: number): Promise<Socket> {
  return resolveTarget().then(
    (address) =>
      new Promise<Socket>((resolve, reject) => {
        const s = new Socket();
        const timer = setTimeout(() => {
          s.destroy();
          reject(new Error("timeout"));
        }, timeoutMs);
        s.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        s.connect(targetPort, address, () => {
          clearTimeout(timer);
          s.removeAllListeners("error");
          resolve(s);
        });
      }),
  );
}

const server = createServer((client) => {
  client.on("error", () => client.destroy());
  if (mode === "report") {
    upstream(5000).then(
      (s) => {
        s.destroy();
        client.end("1");
      },
      () => client.end("0"),
    );
    return;
  }
  client.pause();
  upstream(15000).then(
    (s) => {
      s.on("error", () => client.destroy());
      client.on("close", () => s.destroy());
      s.on("close", () => client.destroy());
      client.pipe(s).pipe(client);
      client.resume();
    },
    () => client.destroy(),
  );
});
server.maxConnections = maxConnections;
server.listen(listenPort, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => process.exit(0));
