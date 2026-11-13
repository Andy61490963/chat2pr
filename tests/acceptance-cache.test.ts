import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Containers } from "../server/containers.js";
import { SourceCache, sourceVolume } from "../server/source-cache.js";
import { GitHub } from "../server/github.js";
import type { Project } from "../shared/types.js";

const worker =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
const sourceImage =
  process.env.ACCEPTANCE_SOURCE_IMAGE ?? "line-agentflow-source:local";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();

async function fixture() {
  const key = randomUUID().slice(0, 8),
    a = new Containers(`verify-cache-a-${key}`),
    b = new Containers(`verify-cache-b-${key}`);
  const source = {
    repo: `fixture-${key}/repo`,
    repositoryId: 1,
    installationId: 1,
    token: "驗收專用虛構憑證",
    sha: "",
  };
  const networkA = await a.sourceNetwork(),
    networkB = await b.sourceNetwork();
  const remote = docker(
    "run",
    "-d",
    "--network",
    networkA,
    "--label",
    `io.agentflow.instance=${a.instance}`,
    "--entrypoint",
    "sh",
    sourceImage,
    "-ec",
    "mkdir /repo; git init -q /repo; cd /repo; git config user.name 驗收; git config user.email verify@localhost; printf '第一版' > README.md; head -c 1048576 /dev/urandom > large.bin; git add .; git commit -qm 第一版; exec git daemon --reuseaddr --export-all --listen=0.0.0.0 /repo",
  );
  docker("network", "connect", networkB, remote);
  const command = (script: string) =>
    docker("exec", remote, "sh", "-ec", script);
  const runs: Array<[Containers, string]> = [],
    volumes: string[] = [];
  const cacheCommand = (owner: Containers, script: string) =>
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--label",
      `io.agentflow.instance=${owner.instance}`,
      "-v",
      `${sourceVolume(source, owner.instance)}:/cache`,
      "--entrypoint",
      "sh",
      sourceImage,
      "-ec",
      script,
    );
  let first = "";
  for (let n = 0; n < 100; n++) {
    try {
      first = command("git -C /repo rev-parse HEAD");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expect(first).toMatch(/^[a-f0-9]{40}$/);
  for (const owner of [a, b]) {
    const volume = sourceVolume(source, owner.instance);
    volumes.push(volume);
    await owner.ensureVolume(volume, undefined, true);
    const ip = (await owner.docker.getContainer(remote).inspect())
      .NetworkSettings.Networks[owner.network("bridge")].IPAddress;
    cacheCommand(
      owner,
      `git init --bare -q /cache/repository; git --git-dir=/cache/repository config url.git://${ip}/repo.insteadOf https://github.com/${source.repo}.git`,
    );
  }
  const prepare = async (owner: Containers, sha: string, id = randomUUID()) => {
    runs.push([owner, id]);
    return {
      id,
      report: await new SourceCache(owner, sourceImage).prepare(
        id,
        worker,
        { ...source, sha },
        30000,
      ),
    };
  };
  const read = async (owner: Containers, id: string) => {
    const result = await owner.phase(id, worker, [
      "sh",
      "-ec",
      "cat README.md; printf '\\n'; git rev-parse HEAD^{tree}; git status --porcelain",
    ]);
    expect(result.exitCode).toBe(0);
    return result.stdout;
  };
  return {
    a,
    b,
    source,
    first,
    prepare,
    read,
    command,
    cacheCommand,
    async close() {
      docker("rm", "-f", remote);
      for (const [owner, id] of runs) await owner.dispose(id);
      for (const volume of volumes) await a.docker.getVolume(volume).remove();
      for (const network of [networkA, networkB])
        await a.docker.getNetwork(network).remove();
    },
  };
}

it("E09.versions：同 run ID 的兩環境冷快取、命中、新舊 SHA 與工作副本一致且不互相污染", async () => {
  const f = await fixture();
  try {
    const shared = randomUUID(),
      cold = await f.prepare(f.a, f.first, shared),
      other = await f.prepare(f.b, f.first, shared);
    expect(cold.report.cache).toBe("cold");
    expect(other.report.cache).toBe("cold");
    const original = await f.read(f.a, cold.id);
    expect(await f.read(f.b, other.id)).toBe(original);
    const modified = await f.a.phase(cold.id, worker, [
      "sh",
      "-ec",
      "printf '獨立任務修改' > README.md",
    ]);
    expect(modified.exitCode).toBe(0);
    expect(await f.read(f.b, other.id)).toBe(original);
    const hit = await f.prepare(f.a, f.first);
    expect(hit.report.cache).toBe("hit");
    expect(hit.report.snapshotHit).toBe(true);
    expect(await f.read(f.a, hit.id)).toBe(original);
    f.command(
      "cd /repo; printf '第二版' > README.md; git add README.md; git commit -qm 第二版",
    );
    const next = f.command("git -C /repo rev-parse HEAD"),
      updated = await f.prepare(f.a, next);
    expect(updated.report.cache).toBe("updated");
    expect(await f.read(f.a, updated.id)).toContain("第二版");
    const old = await f.prepare(f.a, f.first);
    expect(old.report.cache).toBe("hit");
    expect(await f.read(f.a, old.id)).toBe(original);
    await f.a.cleanup();
    await f.a.dispose(shared);
    expect(await f.read(f.b, other.id)).toBe(original);
    expect(
      (
        await f.b.docker
          .getVolume(sourceVolume(f.source, f.b.instance))
          .inspect()
      ).Labels?.["io.agentflow.instance"],
    ).toBe(f.b.instance);
    const timings = {
      cold: cold.report,
      same: hit.report,
      next: updated.report,
      old: old.report,
    };
    console.log("快取實測毫秒", JSON.stringify(timings));
    if (process.env.ACCEPTANCE_ARTIFACT_DIR) {
      mkdirSync(process.env.ACCEPTANCE_ARTIFACT_DIR, { recursive: true });
      writeFileSync(
        join(process.env.ACCEPTANCE_ARTIFACT_DIR, "cache-timings.json"),
        JSON.stringify(timings, null, 2),
      );
    }
  } finally {
    await f.close();
  }
}, 120000);

it("E09.corrupt：快照內容損壞後不可當成命中，必須重建出同一棵樹", async () => {
  const f = await fixture();
  try {
    const initial = await f.prepare(f.a, f.first),
      original = await f.read(f.a, initial.id);
    f.cacheCommand(f.a, "printf '損壞的快取內容' > /cache/snapshot/README.md");
    const restored = await f.prepare(f.a, f.first);
    expect(
      restored.report.snapshotHit,
      "不能只靠 snapshot-sha 判定快取完整",
    ).toBe(false);
    expect(await f.read(f.a, restored.id)).toBe(original);
  } finally {
    await f.close();
  }
}, 120000);

it("E10.permission：已有快取仍重新檢查存取權，GitHub 403 替身不得取得下載憑證", async () => {
  const f = await fixture();
  try {
    await f.prepare(f.a, f.first);
    const github = new GitHub();
    vi.spyOn(github, "installation").mockResolvedValue(1);
    const get = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("GitHub 403：已撤銷權限"), { status: 403 }),
      );
    vi.spyOn(github, "client").mockResolvedValue({ repos: { get } } as never);
    await expect(
      github.sourceAccess({ repo: f.source.repo } as Project, f.first),
    ).rejects.toThrow("已撤銷權限");
    expect(get).toHaveBeenCalledOnce();
    expect(
      (
        await f.a.docker
          .getVolume(sourceVolume(f.source, f.a.instance))
          .inspect()
      ).Name,
    ).toBe(sourceVolume(f.source, f.a.instance));
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 120000);
