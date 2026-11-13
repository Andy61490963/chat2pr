import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Containers } from "../server/containers.js";
import { SourceCache, sourceVolume } from "../server/source-cache.js";

it("真快取容器逾時與 Docker 移除中的 409 重疊，仍保留 408 並可立即 dispose", async () => {
  const c = new Containers(`verify-source-race-${randomUUID().slice(0, 8)}`),
    run = randomUUID(),
    lockRun = randomUUID(),
    sourceImage =
      process.env.SOURCE_CACHE_IMAGE ?? "line-agentflow-source:local",
    worker =
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
  const source = {
    repo: "fixture/timeout",
    sha: "a".repeat(40),
    repositoryId: 1,
    installationId: 1,
    token: "測試憑證",
  };
  const cacheName = sourceVolume(source, c.instance);
  await c.ensureVolume(cacheName, undefined, true);
  const lock = await c.docker.createContainer({
    Image: sourceImage,
    Entrypoint: [
      "sh",
      "-ec",
      "flock -x /cache/lock sh -c 'echo locked; sleep 60'",
    ],
    Labels: c.labels(lockRun),
    HostConfig: { NetworkMode: "none", Binds: [`${cacheName}:/cache`] },
  });
  let target = "",
    injected = false,
    removal: Promise<unknown> | undefined;
  const get = c.docker.getContainer.bind(c.docker),
    create = c.docker.createContainer.bind(c.docker);
  const created = vi
    .spyOn(c.docker, "createContainer")
    .mockImplementation(async (...args) => {
      const container = await create(...args);
      target = container.id;
      return container;
    });
  const handles = vi
    .spyOn(c.docker, "getContainer")
    .mockImplementation((id) => {
      const handle = get(id);
      if (id === target) {
        const remove = handle.remove.bind(handle);
        handle.remove = (async (...args: Parameters<typeof remove>) => {
          if (!injected) {
            injected = true;
            removal = new Promise((resolve) => setTimeout(resolve, 200)).then(
              () => remove(...args),
            );
            void removal.catch(() => {});
            throw Object.assign(new Error("removal already in progress"), {
              statusCode: 409,
            });
          }
          return remove(...args);
        }) as typeof handle.remove;
      }
      return handle;
    });
  try {
    // 此例驗證進入準備階段後的清理競態，不量測 Docker 冷啟動 SLA。
    // 先完成固定環境的建立；短暫主機負載不能讓 400ms 期限在故障點之前耗盡。
    await c.ensureVolume(c.volume(run), run);
    await c.sourceNetwork();
    await c.ready(worker);
    await lock.start();
    let locked = false;
    for (let n = 0; n < 100; n++) {
      const logs = await lock.logs({ stdout: true, stderr: true });
      if (logs.toString().includes("locked")) {
        locked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(locked).toBe(true);
    await expect(
      new SourceCache(c, sourceImage).prepare(run, worker, source, 3000),
    ).rejects.toMatchObject({
      statusCode: 408,
      message: "專案快取準備超過時間限制",
    });
    expect(target, "必須真正建立快取容器，才能驗收移除競態").not.toBe("");
    expect(injected).toBe(true);
    await c.dispose(run);
    await expect(get(target).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      c.docker.getVolume(c.volume(run)).inspect(),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await c.docker.getVolume(cacheName).inspect()).Labels[
        "io.agentflow.instance"
      ],
    ).toBe(c.instance);
  } finally {
    created.mockRestore();
    handles.mockRestore();
    await removal?.catch((e) => {
      if (![404, 409].includes(e.statusCode)) throw e;
    });
    await c.dispose(run);
    await c.removeOwnedContainer(lock.id, lockRun);
    await c.docker.getVolume(cacheName).remove();
    const network = c.docker.getNetwork(`${c.instance}_source`);
    const info = await network.inspect().catch(() => undefined);
    if (info) {
      expect(info.Labels?.["io.agentflow.instance"]).toBe(c.instance);
      await network.remove();
    }
  }
}, 30000);
