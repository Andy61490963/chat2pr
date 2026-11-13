import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Containers } from "../server/containers.js";
import { SourceCache, sourceVolume } from "../server/source-cache.js";

const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
it("相同版本不抓取、增量只補物件；工作副本、唯讀基底與下載憑證互相隔離", async () => {
  const c = new Containers(),
    cache = new SourceCache(c);
  const key = randomUUID(),
    remote = `source-fixture-${key}`,
    runs: string[] = [];
  const source = {
    repo: `fixture-${key}/repo`,
    repositoryId: 1,
    installationId: 1,
    sha: "",
    token: "測試下載憑證不可落地",
  };
  const volume = sourceVolume(source);
  const command = (script: string) =>
    docker("exec", remote, "sh", "-ec", script);
  try {
    docker(
      "run",
      "-d",
      "--name",
      remote,
      "--entrypoint",
      "sh",
      "line-agentflow-source:local",
      "-ec",
      "mkdir /repo; git init -q /repo; cd /repo; git config user.name test; git config user.email test@localhost; printf '第一版' > README.md; printf '#!/bin/sh\\ntrue\\n' > check.sh; chmod +x check.sh; ln -s README.md link; head -c 1048576 /dev/urandom > large.bin; git add .; git commit -qm 第一版; exec git daemon --reuseaddr --export-all --listen=0.0.0.0 /repo",
    );
    // 等待遠端測試資料完成建立，不依賴固定睡眠長度。
    let sha = "";
    for (let n = 0; n < 100; n++) {
      try {
        sha = command("git -C /repo rev-parse HEAD");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const ip = docker(
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      remote,
    );
    await c.ensureVolume(volume, undefined, true);
    // 測試專用 Git 來源，避免 CI 使用真實 GitHub 憑證或改動遠端儲存庫。
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${volume}:/cache`,
      "--entrypoint",
      "sh",
      "line-agentflow-source:local",
      "-ec",
      `git init --bare -q /cache/repository; git --git-dir=/cache/repository config url.git://${ip}/repo.insteadOf https://github.com/${source.repo}.git`,
    );
    const prepare = async (commit: string, timeoutMs?: number) => {
      const id = randomUUID();
      runs.push(id);
      return {
        id,
        report: await cache.prepare(
          id,
          process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
          { ...source, sha: commit },
          timeoutMs,
        ),
      };
    };
    const first = await prepare(sha);
    expect(first.report.cache).toBe("cold");
    expect(first.report.addedObjectBytes).toBeGreaterThan(1000000);
    const mutation = await c.phase(
      first.id,
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      [
        "sh",
        "-ec",
        "test ! -e /cache; test -z \"$AGENTFLOW_SOURCE_TOKEN\"; test -x check.sh; test -L link; printf '任務修改' > README.md; node /opt/agentflow/collect.mjs",
      ],
    );
    expect(mutation.exitCode).toBe(0);
    expect(
      JSON.parse(mutation.stdout).files.map((f: { path: string }) => f.path),
    ).toEqual(["README.md"]);
    await expect(
      cache.prepare(
        first.id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        {
          ...source,
          sha,
        },
      ),
    ).rejects.toThrow("副本已存在");
    const warm = await prepare(sha);
    expect(warm.report).toMatchObject({
      cache: "hit",
      snapshotHit: true,
      addedObjectBytes: 0,
    });
    const clean = await c.phase(
      warm.id,
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      ["node", "/opt/agentflow/collect.mjs"],
    );
    expect(clean.exitCode).toBe(0);
    expect(JSON.parse(clean.stdout).files).toEqual([]);
    const parallel = await Promise.all([prepare(sha), prepare(sha)]);
    expect(parallel.every((x) => x.report.snapshotHit)).toBe(true);
    command(
      "cd /repo; printf '第二版' > README.md; git add README.md; git commit -qm 第二版",
    );
    const next = command("git -C /repo rev-parse HEAD");
    const updated = await prepare(next);
    expect(updated.report.cache).toBe("updated");
    expect(updated.report.addedObjectBytes).toBeLessThan(
      first.report.addedObjectBytes / 10,
    );
    const content = await c.phase(
      updated.id,
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      ["cat", "README.md"],
    );
    expect(content.stdout).toBe("第二版");
    const stale = await prepare(sha);
    expect(stale.report.cache).toBe("hit");
    const old = await c.phase(
      stale.id,
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      ["cat", "README.md"],
    );
    expect(old.stdout).toBe("第一版");
    // 無效 commit 不會覆蓋最後一份可用快照，失敗可恢復。
    await expect(prepare("a".repeat(40))).rejects.toThrow("快取準備失敗");
    expect((await prepare(sha)).report.snapshotHit).toBe(true);
    const inspected = docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${volume}:/cache:ro`,
      "--entrypoint",
      "sh",
      "line-agentflow-source:local",
      "-ec",
      "! grep -R -a -l '測試下載憑證不可落地' /cache; test -z \"$(git --git-dir=/cache/repository remote)\"",
    );
    expect(inspected).toBe("");
    // 跨程序鎖定中的工作逾時可停止，不留下活動容器或破壞快取。
    const lock = docker(
      "run",
      "-d",
      "--network",
      "none",
      "-v",
      `${volume}:/cache`,
      "--entrypoint",
      "flock",
      "line-agentflow-source:local",
      "-x",
      "/cache/lock",
      "sh",
      "-c",
      "touch /cache/locked; sleep 30",
    );
    try {
      for (let n = 0; n < 100; n++) {
        try {
          docker("exec", lock, "test", "-f", "/cache/locked");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      await expect(prepare(sha, 1000)).rejects.toThrow("時間限制");
      const cancelledId = randomUUID();
      runs.push(cancelledId);
      const cancelled = cache
        .prepare(
          cancelledId,
          process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
          { ...source, sha },
          10000,
        )
        .then(
          () => false,
          () => true,
        );
      let active = false;
      for (let n = 0; n < 100; n++) {
        active =
          (
            await c.docker.listContainers({
              all: true,
              filters: JSON.stringify({
                label: [`io.agentflow.run=${cancelledId}`],
              }),
            })
          ).length > 0;
        if (active) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(active).toBe(true);
      await c.cancel(cancelledId);
      expect(await cancelled).toBe(true);
      expect(
        await c.docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: [`io.agentflow.run=${cancelledId}`],
          }),
        }),
      ).toHaveLength(0);
    } finally {
      docker("rm", "-f", lock);
    }
    expect((await prepare(sha)).report.cache).toBe("hit");
    expect(sourceVolume({ ...source, installationId: 2 })).not.toBe(volume);
    expect(sourceVolume({ ...source, repositoryId: 2 })).not.toBe(volume);
  } finally {
    for (const id of runs) await c.dispose(id);
    docker("rm", "-f", remote);
    await c.docker
      .getVolume(volume)
      .remove()
      .catch(() => {});
  }
}, 120000);
