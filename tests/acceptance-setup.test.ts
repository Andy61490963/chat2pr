import { expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import {
  acceptanceSetupConfig,
  pinSubscriptionRelay,
  acceptanceRunnerReady,
} from "../scripts/acceptance/setup-config.js";

const base = { ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE: "relay:驗收" };

it("預設驗收代理與 runner 使用相鄰獨立埠，明確設定會同步至轉送器", () => {
  expect(acceptanceSetupConfig(base).ports.broker).toBe(14313);
  expect(
    acceptanceSetupConfig({ ...base, RUNNER_LISTEN_PORT: "15312" }).ports
      .broker,
  ).toBe(15313);
  for (const key of [
    "SUBSCRIPTION_BROKER_PORT",
    "ACCEPTANCE_SUBSCRIPTION_BROKER_PORT",
  ])
    expect(
      acceptanceSetupConfig({ ...base, [key]: "16313" }).ports.broker,
    ).toBe(16313);
  expect(() =>
    acceptanceSetupConfig({
      ...base,
      SUBSCRIPTION_BROKER_PORT: "16313",
      ACCEPTANCE_SUBSCRIPTION_BROKER_PORT: "17313",
    }),
  ).toThrow("必須一致");
});

async function withHealthServer(
  reply: (response: ServerResponse) => void,
  check: (url: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    if (
      request.url !== "/health" ||
      request.headers["x-runner-key"] !== "test-only"
    ) {
      response.writeHead(401).end();
      return;
    }
    reply(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  try {
    await check(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it.each([
  { ok: true, instance: "verify-health" },
  { ok: true, instance: "verify-other", subscriptionBroker: "v1" },
  { ok: false, instance: "verify-health", subscriptionBroker: "v1" },
  { ok: true, instance: "verify-health", subscriptionBroker: "v0" },
  null,
])(
  "舊版或非本套件的健康回應不得沿用，也不啟動另一個 runner：%j",
  async (body) => {
    await withHealthServer(
      (r) => r.end(JSON.stringify(body)),
      async (url) => {
        await expect(
          acceptanceRunnerReady(url, "test-only", "verify-health"),
        ).rejects.toThrow("該埠");
      },
    );
  },
);

it("只接受同 instance 且支援訂閱代理 v1 的健康程序", async () => {
  await withHealthServer(
    (r) =>
      r.end(
        JSON.stringify({
          ok: true,
          instance: "verify-health",
          subscriptionBroker: "v1",
        }),
      ),
    async (url) => {
      await expect(
        acceptanceRunnerReady(url, "test-only", "verify-health"),
      ).resolves.toBe(true);
    },
  );
});

it("逾時、憑證錯誤及不完整回應均拒絕啟動新程序", async () => {
  for (const reply of [
    (_r: ServerResponse) => {},
    (r: ServerResponse) => {
      r.writeHead(401).end();
    },
    (r: ServerResponse) => {
      r.end("{unfinished");
    },
  ])
    await withHealthServer(reply, async (url) => {
      await expect(
        acceptanceRunnerReady(url, "test-only", "verify-health", 80),
      ).rejects.toThrow("該埠");
    });
});

it("明確未監聽的驗收埠才允許啟動", async () => {
  let closedUrl = "";
  await withHealthServer(
    (r) => r.end(),
    async (url) => {
      closedUrl = url;
    },
  );
  await expect(
    acceptanceRunnerReady(closedUrl, "test-only", "verify-health"),
  ).resolves.toBe(false);
});

it("不跟隨健康回應重新導向，也不將執行器金鑰轉送其他入口", async () => {
  let forwarded = 0;
  await withHealthServer(
    (r) => {
      forwarded++;
      r.end(
        JSON.stringify({
          ok: true,
          instance: "verify-health",
          subscriptionBroker: "v1",
        }),
      );
    },
    async (target) => {
      await withHealthServer(
        (r) => {
          r.writeHead(302, { location: `${target}/health` }).end();
        },
        async (url) => {
          await expect(
            acceptanceRunnerReady(url, "test-only", "verify-health"),
          ).rejects.toThrow("該埠");
        },
      );
    },
  );
  expect(forwarded).toBe(0);
});

it.each([
  "4310",
  "4311",
  "4312",
  "4313",
  "5439",
  "14310",
  "14312",
  "15440",
  "18080",
  "0",
  "NaN",
  "65536",
])("拒絕正式、重複或無效代理埠 %s", (port) => {
  expect(() =>
    acceptanceSetupConfig({ ...base, SUBSCRIPTION_BROKER_PORT: port }),
  ).toThrow();
});

it("在建立登入副本前要求專用轉送映像，固定至經檢查的映像 ID", () => {
  for (const value of [undefined, "", "--help", "relay with spaces"])
    expect(() =>
      acceptanceSetupConfig({ ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE: value }),
    ).toThrow("ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE");
  const id = `sha256:${"a".repeat(64)}`;
  const image = {
    Id: id,
    Config: { Labels: { "io.agentflow.subscription-relay": "v1" } },
  };
  expect(pinSubscriptionRelay([image])).toBe(id);
  for (const invalid of [
    null,
    [],
    [image, image],
    [{ ...image, Id: "relay:latest" }],
    [{ Id: id }],
    [
      {
        ...image,
        Config: { Labels: { "io.agentflow.subscription-relay": "v2" } },
      },
    ],
  ])
    expect(() => pinSubscriptionRelay(invalid)).toThrow("專用版本標記");
});
