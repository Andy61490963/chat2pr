import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceName, validateRunnerEnvironment } from "../server/config.js";
import { Containers } from "../server/containers.js";
import { sourceVolume } from "../server/source-cache.js";

describe("執行環境命名與啟動限制", () => {
  it("拒絕不明名稱，正式名稱維持相容，驗收各自隔離", () => {
    const run = randomUUID(),
      a = new Containers("verify-a"),
      b = new Containers("verify-b");
    expect(instanceName("production")).toBe("production");
    for (const value of ["", "Production", "verify-", "../production", "test"])
      expect(() => instanceName(value)).toThrow();
    expect(new Containers("production").volume(run)).toBe(
      `agentflow-job-${run}`,
    );
    expect(a.volume(run)).not.toBe(b.volume(run));
    expect(a.network("line-agentflow_ai")).toBe("verify-a_ai");
    expect(a.network("line-agentflow_install")).toBe("verify-a_install");
    expect(a.network("bridge")).toBe("verify-a_source");
    expect(a.network("none")).toBe("none");
    expect(() => a.network("verify-b_ai")).toThrow();
    const source = {
      repo: "example-org/test",
      installationId: 1,
      repositoryId: 2,
    };
    expect(sourceVolume(source, a.instance)).not.toBe(
      sourceVolume(source, b.instance),
    );
    expect(sourceVolume(source, "production")).toMatch(/^agentflow-source-v1-/);
  });
  it("驗收 runner 在 Docker 清理前要求獨立機密、登入目錄和埠", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-config-"));
    try {
      const dir = join(root, "verify-config");
      mkdirSync(dir);
      const env = {
        AGENTFLOW_INSTANCE: "verify-config",
        CODEX_SERVICE_HOME: join(dir, "codex"),
        SECRETS_FILE: join(dir, "secrets.json"),
        RUNNER_LISTEN_PORT: "14312",
      };
      expect(() => validateRunnerEnvironment(env)).toThrow("已建立");
      writeFileSync(
        env.SECRETS_FILE,
        JSON.stringify({ runnerSecret: "測試".repeat(20) }),
      );
      expect(() => validateRunnerEnvironment(env)).not.toThrow();
      expect(() =>
        validateRunnerEnvironment({ ...env, CODEX_SERVICE_HOME: undefined }),
      ).toThrow("CODEX_SERVICE_HOME");
      expect(() =>
        validateRunnerEnvironment({
          ...env,
          SECRETS_FILE: ".local/secrets.json",
        }),
      ).toThrow("SECRETS_FILE");
      expect(() =>
        validateRunnerEnvironment({ ...env, RUNNER_LISTEN_PORT: "4312" }),
      ).toThrow("RUNNER_LISTEN_PORT");
      writeFileSync(env.SECRETS_FILE, JSON.stringify({ runnerSecret: "短" }));
      expect(() => validateRunnerEnvironment(env)).toThrow("32");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("真實 Docker：相同 run ID 的 cleanup、cancel、dispose 不影響其他環境與舊容器", async () => {
  const suffix = randomUUID().slice(0, 8),
    run = randomUUID();
  const a = new Containers(`verify-sentinel-a-${suffix}`),
    b = new Containers(`verify-sentinel-b-${suffix}`);
  const image =
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
    created: string[] = [],
    extraVolumes: string[] = [];
  const sentinel = async (owner: Containers, legacy = false) => {
    const vol = legacy
      ? `agentflow-sentinel-legacy-${suffix}`
      : owner.volume(run);
    if (legacy) {
      await owner.docker.createVolume({
        Name: vol,
        Labels: { "io.agentflow.sentinel": suffix },
      });
      extraVolumes.push(vol);
    } else await owner.ensureVolume(vol, run);
    const c = await owner.docker.createContainer({
      Image: image,
      Entrypoint: [
        "node",
        "-e",
        "const f=require('fs');let n=0;setInterval(()=>f.writeFileSync('/workspace/ticks',String(++n)),50)",
      ],
      Cmd: [],
      Labels: legacy
        ? { "io.agentflow.managed": "true", "io.agentflow.run": run }
        : owner.labels(run),
      HostConfig: { NetworkMode: "none", Binds: [`${vol}:/workspace`] },
    });
    created.push(c.id);
    await c.start();
    return c;
  };
  const tick = async (c: Awaited<ReturnType<typeof sentinel>>) => {
    const stream = await c.getArchive({ path: "/workspace/ticks" });
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    return Number(
      Buffer.concat(chunks).subarray(512, 530).toString().replace(/\0/g, ""),
    );
  };
  try {
    const ca = await sentinel(a),
      cb = await sentinel(b),
      legacy = await sentinel(a, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await tick(cb),
      legacyBefore = await tick(legacy);
    await a.cleanup();
    await expect(ca.inspect()).rejects.toMatchObject({ statusCode: 404 });
    expect((await cb.inspect()).State.Running).toBe(true);
    expect((await legacy.inspect()).State.Running).toBe(true);
    await a.dispose(run);
    expect(
      (await b.docker.getVolume(b.volume(run)).inspect()).Labels?.[
        "io.agentflow.instance"
      ],
    ).toBe(b.instance);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await tick(cb)).toBeGreaterThan(before);
    expect(await tick(legacy)).toBeGreaterThan(legacyBefore);
    const ca2 = await sentinel(a);
    await b.cancel(run);
    await expect(cb.inspect()).rejects.toMatchObject({ statusCode: 404 });
    expect((await ca2.inspect()).State.Running).toBe(true);
    await b.dispose(run);
    expect(
      (await a.docker.getVolume(a.volume(run)).inspect()).Labels?.[
        "io.agentflow.instance"
      ],
    ).toBe(a.instance);
    // 相同名稱但標記屬於別人的卷不可掛載，也不能被 dispose 認領。
    const wrongRun = randomUUID(),
      wrong = a.volume(wrongRun);
    await a.docker.createVolume({ Name: wrong, Labels: b.labels(wrongRun) });
    extraVolumes.push(wrong);
    await expect(a.ensureVolume(wrong, wrongRun)).rejects.toThrow("不屬於");
    await expect(a.dispose(wrongRun)).rejects.toThrow("拒絕清除");
    expect(
      (await a.docker.getVolume(wrong).inspect()).Labels?.[
        "io.agentflow.instance"
      ],
    ).toBe(b.instance);
    const net = await a.sourceNetwork();
    expect(net).toBe(`${a.instance}_source`);
    expect(
      (await a.docker.getNetwork(net).inspect()).Labels?.[
        "io.agentflow.instance"
      ],
    ).toBe(a.instance);
    console.log(
      "隔離哨兵通過",
      JSON.stringify({
        instanceA: a.instance,
        instanceB: b.instance,
        runId: run,
        otherHeartbeat: true,
        legacyHeartbeat: true,
      }),
    );
  } finally {
    // 只刪本測試親手建立的 ID，禁止以全域 managed 標籤清理。
    for (const id of created)
      await a.docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => {});
    await a.dispose(run);
    await b.dispose(run);
    for (const name of extraVolumes)
      await a.docker
        .getVolume(name)
        .remove()
        .catch(() => {});
    await a.docker
      .getNetwork(a.network("bridge"))
      .remove()
      .catch(() => {});
  }
}, 30000);
