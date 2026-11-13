import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const worker =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, POSTGRES_PASSWORD: "test-only-model" },
  });
}

it("不連外即可演練模型修復；只有下載及校驗全部成功才替換", () => {
  expect(
    docker([
      "run",
      "--rm",
      "--pull=never",
      "--user",
      "0:0",
      "--network",
      "none",
      "--tmpfs",
      "/models",
      "--mount",
      `type=bind,source=${resolve("infra")},target=/source,readonly`,
      "--mount",
      `type=bind,source=${resolve("tests/model-init.sh")},target=/test.sh,readonly`,
      "--entrypoint",
      "sh",
      worker,
      "/test.sh",
    ]),
  ).toContain("離線修復驗證通過");
});

it("模型服務只讀並與 app 共用內網；即使以 root 執行也不能改模型或連外", () => {
  const { services, networks } = JSON.parse(
    docker(["compose", "--profile", "*", "config", "--format", "json"]),
  );
  const model = services.embedder;
  expect(Object.keys(model.networks)).toEqual(["embed"]);
  expect(networks.embed.internal).toBe(true);
  expect(
    Object.keys(services)
      .filter((s) => Object.hasOwn(services[s].networks ?? {}, "embed"))
      .sort(),
  ).toEqual(["app", "embedder"]);
  expect(model.environment.HF_HUB_OFFLINE).toBe("1");
  expect(
    model.volumes.find((v: { target: string }) => v.target === "/models"),
  ).toMatchObject({ source: "embed-models", read_only: true });
  expect(
    services["embedder-init"].volumes.find(
      (v: { target: string }) => v.target === "/models",
    )?.read_only,
  ).toBeFalsy();
  const isolated = "rag-check-" + randomUUID();
  docker(["network", "create", "--internal", isolated]);
  try {
    // 不掛載任何既有模型卷：以同樣的唯讀掛載和內部網路驗證 Linux 實際限制。
    const result = docker([
      "run",
      "--rm",
      "--pull=never",
      "--user",
      "0:0",
      "--network",
      isolated,
      "--mount",
      `type=bind,source=${resolve("infra")},target=/models,readonly`,
      "--entrypoint",
      "node",
      worker,
      "-e",
      `const fs=require('node:fs'), net=require('node:net');
       try { const fd=fs.openSync('/models/bge-m3.sha256','r+'); fs.closeSync(fd); process.exit(2); } catch(e) { if(e.code!=='EROFS') throw e; }
       const s=net.createConnection({host:'192.0.2.1', port:443});
       s.on('connect',()=>process.exit(3)); s.on('error',e=>{if(!['ENETUNREACH','EHOSTUNREACH'].includes(e.code)) throw e; console.log('已隔離');});
       s.setTimeout(3000,()=>process.exit(4));`,
    ]);
    expect(result).toContain("已隔離");
  } finally {
    docker(["network", "rm", isolated]);
  }
});
