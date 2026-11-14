import { createInterface } from "node:readline";
import { CaptureInput, runCheckQuery } from "./database-capture.js";
import { httpProbeVia, tcpProbeVia } from "./check-probes.js";
import { AppError } from "./policy.js";

/**
 * 定期檢查容器內的執行程式（#19），在檢查映像內以 `node /opt/check/agent.mjs` 執行。
 *
 * 主機執行器以容器的標準輸入逐行送 JSON：
 * - 第一行 `{"kind":"sql","connection":{...}}`：SQL 檢查的連線機密只在這裡交付，只存在這個程序的記憶體；
 * - 之後每行一個請求 `{"id":1,"sql":"SELECT ..."}`／`{"id":1,"url":"...","contains":"..."}`／`{"id":1}`。
 * 每個請求回一行 `{"id":1,"ok":true,"result":...}` 或 `{"id":1,"ok":false,"status":422,"message":"..."}`。
 * 標準輸入關閉（主機執行器結束或清除環境）時程序結束，容器跟著停止。
 *
 * 容器只接上專用內部網路，唯一能連的是轉接器 `target:7000`。
 */

const via = {
  host: process.env.FORWARDER_HOST ?? "target",
  port: Number(process.env.FORWARDER_PORT ?? 7000),
};

type Init = { kind: "sql" | "http" | "tcp"; connection?: CaptureInput };
let init: Init | undefined;

const send = (line: unknown) =>
  process.stdout.write(`${JSON.stringify(line)}\n`);

async function handle(request: Record<string, unknown>) {
  if (!init) throw new AppError(400, "檢查環境尚未初始化");
  if (init.kind === "sql") {
    if (!init.connection) throw new AppError(400, "檢查環境沒有連線設定");
    if (typeof request.sql !== "string")
      throw new AppError(400, "缺少檢查查詢");
    return { rows: await runCheckQuery(init.connection, request.sql, via) };
  }
  if (init.kind === "http") {
    if (typeof request.url !== "string") throw new AppError(400, "缺少網址");
    return httpProbeVia(
      request.url,
      typeof request.contains === "string" ? request.contains : undefined,
      via,
    );
  }
  return tcpProbeVia(via);
}

// 一次只處理一個請求：主機執行器也是逐一送出，避免同一環境並行連線。
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (raw) => {
  queue = queue.then(async () => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!init) {
      const kind = message.kind;
      if (kind !== "sql" && kind !== "http" && kind !== "tcp") {
        send({ ready: false, message: "檢查種類不正確" });
        return;
      }
      const parsed =
        kind === "sql" ? CaptureInput.safeParse(message.connection) : null;
      if (parsed && !parsed.success) {
        send({ ready: false, message: "連線設定格式不正確" });
        return;
      }
      init = { kind, ...(parsed ? { connection: parsed.data } : {}) };
      send({ ready: true });
      return;
    }
    const id = message.id;
    try {
      send({ id, ok: true, result: await handle(message) });
    } catch (e) {
      send({
        id,
        ok: false,
        status: e instanceof AppError ? e.statusCode : 500,
        message: e instanceof AppError ? e.message : "檢查執行失敗",
      });
    }
  });
});
lines.on("close", () => process.exit(0));
