import { expect, it } from "vitest";
import { access, mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subscriptionBrokerPort } from "../server/config.js";
// @ts-expect-error 工作容器使用原生 ESM，不由主機 TypeScript 產生宣告。
import * as provider from "../worker/provider.mjs";
const { providerOptions, prepareProviderOptions } = provider;
it("從空工作home啟動時建立CLI所需目錄，但不建立auth.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentflow-provider-"));
  try {
    const options = await prepareProviderOptions(
      {
        mode: "subscription",
        token: "synthetic-phase",
        proxyUrl: "http://relay/v1",
      },
      { HOME: home },
    );
    await expect(access(options.env.CODEX_HOME)).resolves.toBeUndefined();
    await expect(
      access(join(options.env.CODEX_HOME, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rmdir(join(home, ".codex")).catch(() => {});
    await rmdir(home);
  }
});
it("訂閱工作只帶階段能力，不需要或回傳主登入檔", () => {
  const options = providerOptions(
    {
      mode: "subscription",
      token: "synthetic-phase",
      proxyUrl: "http://subscription-relay:4313/v1/run/phase",
    },
    { PATH: "/usr/bin", HOME: "/tmp/home" },
  );
  expect(options.apiKey).toBe("synthetic-phase");
  expect(options.config.model_providers.agentflow).toMatchObject({
    requires_openai_auth: false,
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
  });
  expect(options.env).not.toHaveProperty("HTTPS_PROXY");
  expect(options.config.shell_environment_policy.set).not.toHaveProperty(
    "CODEX_API_KEY",
  );
  expect(() =>
    providerOptions({ mode: "subscription", auth: "synthetic-master" }, {}),
  ).toThrow("主訂閱憑證");
  expect(() => providerOptions({ mode: "subscription" }, {})).toThrow(
    "有限推論授權",
  );
});
it("worker串流等待受當階段剩餘期限約束，不能默認五分鐘或超過30分鐘", () => {
  for (const [timeoutMs, expected] of [
    [720000, 720000],
    [3600000, 1800000],
    [100, 1000],
  ]) {
    const o = providerOptions(
      { token: "phase", proxyUrl: "http://relay/v1", timeoutMs },
      {},
    );
    expect(o.config.model_providers.agentflow.stream_idle_timeout_ms).toBe(
      expected,
    );
  }
});
it("訂閱代理埠在任何Docker操作前拒絕正式／驗收混用", () => {
  expect(subscriptionBrokerPort({ AGENTFLOW_INSTANCE: "production" })).toBe(
    4313,
  );
  expect(
    subscriptionBrokerPort({
      AGENTFLOW_INSTANCE: "verify-broker",
      RUNNER_LISTEN_PORT: "14312",
    }),
  ).toBe(14313);
  for (const port of ["4312", "4313", "14312", "0", "NaN"])
    expect(() =>
      subscriptionBrokerPort({
        AGENTFLOW_INSTANCE: "verify-broker",
        RUNNER_LISTEN_PORT: "14312",
        SUBSCRIPTION_BROKER_PORT: port,
      }),
    ).toThrow();
});

it("開發階段的套件代理只給 Codex 執行的命令，不影響 Codex 連推論代理", () => {
  const base = { PATH: "/usr/bin", HOME: "/tmp/home" };
  const tools = { ...base, HTTPS_PROXY: "http://egress:3128" };
  const o = providerOptions(
    { mode: "subscription", token: "fictional-token", proxyUrl: "http://relay/v1" },
    base,
    tools,
  );
  expect(o.env.HTTPS_PROXY).toBeUndefined();
  expect(o.config.shell_environment_policy).toEqual({
    inherit: "none",
    set: tools,
  });
  // 未提供命令環境時沿用原本的設定。
  expect(
    providerOptions(
      { mode: "subscription", token: "fictional-token", proxyUrl: "http://relay/v1" },
      base,
    ).config.shell_environment_policy.set,
  ).toEqual(base);
});
