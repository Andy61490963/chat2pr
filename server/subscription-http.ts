import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { AppError } from "./policy.js";
import type { UpstreamFailure } from "../shared/upstream-failure.js";

export class SubscriptionTransportError extends AppError {
  constructor(status: number, message: string, readonly kind: UpstreamFailure["kind"], readonly upstreamStatus?: number) {
    super(status, message);
  }
}

export const SUBSCRIPTION_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

/** 固定訂閱端點；只由 phase AbortSignal 決定總期限，沒有 fetch 的五分鐘標頭期限。 */
export function createSubscriptionTransport(
  request = httpsRequest,
): typeof fetch {
  return async (address, options) => {
    if (
      String(address) !== SUBSCRIPTION_RESPONSES_URL ||
      options?.method !== "POST" ||
      typeof options.body !== "string" ||
      !options.signal
    )
      throw new SubscriptionTransportError(400, "訂閱上游請求格式無效", "invalid_request");
    const signal = options.signal;
    if (signal.aborted) throw new SubscriptionTransportError(408, "訂閱階段已取消或超過期限", "phase_cancelled");
    return new Promise<Response>((resolve, reject) => {
      let incoming: IncomingMessage | undefined,
        settled = false;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        cleanup();
        incoming?.destroy();
        outgoing.destroy();
      };
      const abort = () => fail(new SubscriptionTransportError(408, "訂閱階段已取消或超過期限", "phase_cancelled"));
      const outgoing = request(
        new URL(SUBSCRIPTION_RESPONSES_URL),
        {
          method: "POST",
          headers: Object.fromEntries(new Headers(options.headers)),
          agent: false,
        },
        (response) => {
          incoming = response;
          if (signal.aborted) {
            abort();
            return;
          }
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            fail(new SubscriptionTransportError(502, "訂閱上游不接受重新導向", "redirect", status));
            return;
          }
          // 不傳遞上游任意標頭、Location、statusText 或錯誤字串。
          const headers = new Headers();
          if (response.headers["content-type"])
            headers.set("content-type", response.headers["content-type"]);
          response.once("end", cleanup);
          response.once("close", cleanup);
          try {
            if ([204, 205].includes(status)) {
              response.destroy();
              settled = true;
              resolve(new Response(null, { status, headers }));
              return;
            }
            const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
            const result = new Response(body, { status, headers });
            settled = true;
            resolve(result);
          } catch {
            fail(new SubscriptionTransportError(502, "訂閱上游回應格式無效", "invalid_stream", response.statusCode));
          }
        },
      );
      outgoing.once("error", () => fail(new SubscriptionTransportError(502, "訂閱上游連線失敗", "connection")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        outgoing.end(options.body);
      } catch {
        fail(new SubscriptionTransportError(502, "訂閱上游傳送失敗", "connection"));
      }
    });
  };
}
export const subscriptionFetch = createSubscriptionTransport();
