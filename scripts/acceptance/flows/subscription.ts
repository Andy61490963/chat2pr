import type { CodexAccount } from "../../../server/codex-account.js";
import { SUBSCRIPTION_RESPONSES_URL } from "../../../server/subscription-http.js";

export const modelAccount = "AcceptanceAccount266";
export const modelToken = "AcceptanceModelToken266";

export function scriptedSubscription(origin: string) {
  const upstreamFetch: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    if (String(url) !== SUBSCRIPTION_RESPONSES_URL || options?.method !== "POST" || !options.signal ||
        headers.get("authorization") !== `Bearer ${modelToken}` || headers.get("chatgpt-account-id") !== modelAccount)
      throw new Error("驗收上游拒絕非劇本身分或非訂閱請求");
    return fetch(`${origin}/backend-api/codex/responses`, {
      method: "POST", redirect: "error", signal: options.signal, body: options.body,
      headers: { authorization: `Bearer ${modelToken}`, "chatgpt-account-id": modelAccount, "content-type": "application/json", accept: "text/event-stream" },
    });
  };
  const readAccount = async (): Promise<CodexAccount> => {
    const response = await fetch(`${origin}/account`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("無法讀取劇本訂閱額度");
    return response.json() as Promise<CodexAccount>;
  };
  return { upstreamFetch, readAccount };
}
