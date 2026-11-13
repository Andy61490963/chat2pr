import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "./policy.js";

export interface RunnerRequestOptions {
  body: string | ReadableStream<Uint8Array>;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes?: number;
}
export type RunnerTransport = typeof runnerRequest;

/** 執行器專用連線；整段請求只有呼叫端的總期限，不使用 fetch 內建的五分鐘標頭期限。 */
export function runnerRequest(
  address: string,
  options: RunnerRequestOptions,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError(400, "執行器網址格式無效");
    const limit = options.maxResponseBytes ?? 32 * 1024 * 1024;
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
      throw new AppError(400, "執行器期限無效");
    let settled = false;
    let input: Readable | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    const finish = (
      error?: Error,
      value?: { status: number; body: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 包括提早回覆、超限及逾時；不能留下繼續上傳的來源或 socket。
      input?.destroy();
      response?.destroy();
      request.destroy();
      if (error) {
        // 與既有診斷契約一致：只讓受控錯誤碼進入 connectionFailure。
        const code = (error as NodeJS.ErrnoException).code;
        reject(typeof code === "string" ? new Error("執行器連線失敗", { cause: { code } }) : error);
      } else resolve(value!);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: options.headers,
        agent: false,
      },
    );
    const timer = setTimeout(() => {
      finish(new DOMException("執行器請求超過時間限制", "TimeoutError"));
    }, options.timeoutMs);
    request.on("error", (error) => finish(error));
    request.on("response", (incoming) => {
      response = incoming;
      if (settled) {
        incoming.destroy();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          finish(new AppError(413, "執行器回應超過傳輸上限，未回傳截斷成果"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("error", (error) => finish(error));
      incoming.on("aborted", () => finish(new Error("執行器回應中斷")));
      incoming.on("end", () => {
        if (!incoming.complete) return finish(new Error("執行器回應不完整"));
        finish(undefined, {
          status: incoming.statusCode ?? 502,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    try {
      if (typeof options.body === "string") request.end(options.body);
      else {
        input = Readable.fromWeb(
          options.body as import("node:stream/web").ReadableStream<Uint8Array>,
        );
        void pipeline(input, request).catch((error) => finish(error));
      }
    } catch (error) {
      // 例如已被其他讀取器鎖定的來源；request 與 timer 已建立，也必須清理。
      finish(error instanceof Error ? error : new Error("執行器上傳來源無效"));
    }
  });
}
