import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  metricsPort,
  tunnelPlan,
  tunnelProvider,
} from "../server/tunnel-provider.js";
import { deployPlan } from "../scripts/lib/deploy-plan.mjs";
import { publicHealth } from "../scripts/lib/public-health.mjs";

const publicUrl = "https://bot.example.test";

describe("固定 HTTPS 入口的提供者", () => {
  it("沒有明確選擇時依已填的憑證判斷", () => {
    expect(tunnelProvider({})).toBeUndefined();
    expect(tunnelProvider({ ngrokToken: "fake-ngrok" })).toBe("ngrok");
    expect(
      tunnelProvider({ ngrokToken: "fake-ngrok", cloudflareConfig: "c.yml" }),
    ).toBe("cloudflare");
  });

  it("明確選擇優先於殘留的舊憑證", () => {
    expect(
      tunnelProvider({ tunnelProvider: "external", ngrokToken: "fake-ngrok" }),
    ).toBe("external");
    expect(
      tunnelPlan({
        tunnelProvider: "external",
        ngrokToken: "fake-ngrok",
        publicUrl,
      }).provider,
    ).toBe("external");
  });

  it("ngrok 使用固定網址的主機名稱", () => {
    expect(tunnelPlan({ ngrokToken: "fake-ngrok", publicUrl })).toEqual({
      provider: "ngrok",
      hostname: "bot.example.test",
      authtoken: "fake-ngrok",
    });
  });

  it("Cloudflare 權杖只經環境變數傳給 cloudflared", () => {
    const plan = tunnelPlan({ cloudflareTunnelToken: "fake-token", publicUrl });
    expect(plan).toEqual({
      provider: "cloudflare",
      hostname: "bot.example.test",
      args: ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:4314", "run"],
      env: { TUNNEL_TOKEN: "fake-token" },
    });
    expect(JSON.stringify("args" in plan && plan.args)).not.toContain(
      "fake-token",
    );
  });

  it("本機管理的通道使用設定檔，可改狀態連接埠", () => {
    expect(
      tunnelPlan({ cloudflareConfig: "C:/cf/config.yml", publicUrl }, 4399),
    ).toMatchObject({
      provider: "cloudflare",
      args: [
        "tunnel",
        "--config",
        "C:/cf/config.yml",
        "--no-autoupdate",
        "--metrics",
        "127.0.0.1:4399",
        "run",
      ],
      env: {},
    });
  });

  it("設定不完整時說明缺少什麼，不啟動通道", () => {
    expect(tunnelPlan({ ngrokToken: "fake-ngrok" })).toMatchObject({
      provider: "none",
    });
    expect(
      tunnelPlan({ ngrokToken: "fake-ngrok", publicUrl: "http://bot.test" }),
    ).toEqual({ provider: "none", detail: "固定入口必須使用 HTTPS" });
    expect(
      tunnelPlan({
        tunnelProvider: "cloudflare",
        ngrokToken: "fake-ngrok",
        publicUrl,
      }),
    ).toMatchObject({
      provider: "none",
      detail: expect.stringContaining("Cloudflare"),
    });
    expect(
      tunnelPlan({
        tunnelProvider: "ngrok",
        cloudflareTunnelToken: "fake-token",
        publicUrl,
      }),
    ).toMatchObject({
      provider: "none",
      detail: expect.stringContaining("ngrok"),
    });
  });

  it("狀態連接埠必須是合法的非特權埠", () => {
    expect(metricsPort({})).toBe(4314);
    expect(metricsPort({ CLOUDFLARED_METRICS_PORT: "4399" })).toBe(4399);
    expect(() => metricsPort({ CLOUDFLARED_METRICS_PORT: "80" })).toThrow();
    expect(() => metricsPort({ CLOUDFLARED_METRICS_PORT: "abc" })).toThrow();
  });
});

describe("部署計畫", () => {
  it("一般程式變更只重啟執行器", () => {
    expect(deployPlan(["server/app.ts", "src/App.tsx", "README.md"])).toEqual({
      install: false,
      host: "runner",
      workerChanged: false,
    });
  });

  it("相依套件變更時重裝並重啟全部主機程序", () => {
    expect(deployPlan(["package-lock.json"])).toMatchObject({
      install: true,
      host: "all",
    });
  });

  it("監督程序或通道程式變更時重啟全部主機程序", () => {
    for (const file of [
      "scripts/start-windows.mjs",
      "scripts/tunnel.ts",
      "server/tunnel-provider.ts",
    ])
      expect(deployPlan([file]).host).toBe("all");
    expect(deployPlan([], { restartHost: true }).host).toBe("all");
  });

  it("工作映像變更時提醒重新驗證專案", () => {
    expect(deployPlan(["worker/Dockerfile"]).workerChanged).toBe(true);
  });
});

describe("外部健康檢查", () => {
  const serve = async (status: number) => {
    const server = createServer((_req, res) => res.writeHead(status).end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  };

  it("回應 200 才算正常", async () => {
    const up = await serve(200);
    const down = await serve(502);
    try {
      expect(await publicHealth(up.url)).toMatchObject({
        ok: true,
        status: 200,
      });
      expect(await publicHealth(down.url)).toMatchObject({
        ok: false,
        status: 502,
      });
    } finally {
      up.server.close();
      down.server.close();
    }
  });

  it("連不上時沒有狀態碼", async () => {
    const gone = await serve(200);
    await new Promise((done) => gone.server.close(done));
    const result = await publicHealth(gone.url);
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
  });
});
