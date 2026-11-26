import { expect, it, vi, afterEach } from "vitest";
import { flowSubscriptionOrigin } from "../server/config.js";
import { scriptedSubscription } from "../scripts/acceptance/flows/subscription.js";
import { SUBSCRIPTION_RESPONSES_URL } from "../server/subscription-http.js";

afterEach(() => vi.unstubAllGlobals());

it("正式執行環境及非本機或保留埠的假上游一律拒絕", () => {
  expect(flowSubscriptionOrigin({})).toBeUndefined();
  const env = { AGENTFLOW_INSTANCE: "verify-example", ACCEPTANCE_MODEL_ORIGIN: "http://127.0.0.1:32322" };
  expect(flowSubscriptionOrigin(env)).toBe(env.ACCEPTANCE_MODEL_ORIGIN);
  expect(() => flowSubscriptionOrigin({ ...env, AGENTFLOW_INSTANCE: "production" })).toThrow();
  for (const origin of ["", "http://example.invalid:32322", "http://127.0.0.1:4314", "http://127.0.0.1:32322/path", "http://u@127.0.0.1:32322"]) expect(() => flowSubscriptionOrigin({ ...env, ACCEPTANCE_MODEL_ORIGIN: origin })).toThrow();
});

it("非劇本身分不送往假上游；劇本身分不得轉送其他授權標頭或重新導向", async () => {
  const send = vi.fn(async () => new Response("完成"));
  vi.stubGlobal("fetch", send);
  const { upstreamFetch } = scriptedSubscription("http://127.0.0.1:32322");
  const headers = { authorization: "Bearer UnrelatedToken266", "chatgpt-account-id": "AcceptanceAccount266", cookie: "HiddenCookie266" };
  const options = { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(1000) };
  await expect(upstreamFetch(SUBSCRIPTION_RESPONSES_URL, options)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  headers.authorization = "Bearer AcceptanceModelToken266";
  await upstreamFetch(SUBSCRIPTION_RESPONSES_URL, options);
  expect(send).toHaveBeenCalledOnce();
  expect(JSON.stringify(send.mock.calls)).not.toContain("HiddenCookie266");
  expect(send).toHaveBeenCalledWith("http://127.0.0.1:32322/backend-api/codex/responses", expect.objectContaining({redirect: "error"}));
});
