import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { expect, it, vi } from "vitest";
import { Containers } from "../server/containers.js";
import { derivedImage, packageIdentity } from "../server/derived-image.js";
import { DEFAULT_EGRESS_DOMAINS } from "../shared/install-plan.js";

function fixture() {
  const c = new Containers("verify-derived");
  const request = {
    runId: randomUUID(),
    base: "line-agentflow-worker:local",
    projectId: randomUUID(),
    branch: "main",
    items: [
      {
        name: "agentflow-demo",
        source: "https://deb.debian.org/debian",
        version: "1.0.0",
        purpose: "建立示範工具的目錄",
        commands: ["mkdir -p /opt/agentflow-demo"],
      },
    ],
    domains: DEFAULT_EGRESS_DOMAINS,
    timeoutMs: 10000,
  };
  const baseId = "sha256:current-base";
  const labels = {
    "io.agentflow.derived": "v1",
    "io.agentflow.derived-instance": c.instance,
    "io.agentflow.project": request.projectId,
    "io.agentflow.base": "sha256:old-base",
    "io.agentflow.derived-packages": packageIdentity(request.items),
  };
  const image = (
    id: string,
    labelOverrides: Record<string, string> = {},
    tags = [`agentflow-verify-derived:${id}`],
    containers = 0,
  ) => ({
    Id: `sha256:${id}`,
    Labels: { ...labels, ...labelOverrides },
    RepoTags: tags,
    Containers: containers,
    Size: 7 * 1024 ** 3,
    SharedSize: 5 * 1024 ** 3,
  });
  const old = image("old", {}, ["fictional-image:demo"]);
  const running = image("running");
  const stopped = image("stopped", {}, undefined, 1);
  const inventory = {
    Images: [
      old,
      image("same-base", { "io.agentflow.base": baseId }),
      image("other-packages", { "io.agentflow.derived-packages": "other" }),
      image("other-project", { "io.agentflow.project": randomUUID() }),
      image("other-instance", {
        "io.agentflow.derived-instance": "verify-other",
      }),
      image("missing-base", { "io.agentflow.base": "" }),
      {
        ...image("legacy"),
        Labels: {
          "io.agentflow.derived": "v1",
          "io.agentflow.derived-instance": c.instance,
          "io.agentflow.project": request.projectId,
          "io.agentflow.base": "sha256:old-base",
        },
      },
      { ...image("unlabelled"), Labels: null },
      image("protected-local", {}, [
        "fictional-image:demo",
        "fictional-image:local",
      ]),
      image("protected-latest", {}, ["fictional-image:latest"]),
      running,
      stopped,
    ],
    Containers: [
      {
        Id: "fictional-container",
        Names: ["/fictional-container"],
        Image: "agentflow-verify-derived:running",
        ImageID: running.Id,
        State: "running",
      },
    ],
  };
  let builtLabels: Record<string, string> | undefined;
  const commit = vi.fn(
    async (options: { _body: { Labels: Record<string, string> } }) => {
      builtLabels = options._body.Labels;
    },
  );
  const container = {
    id: "install-container",
    start: vi.fn(),
    wait: vi.fn(async () => ({ StatusCode: 0 })),
    logs: vi.fn(async () => Buffer.alloc(0)),
    commit,
  } as unknown as Docker.Container;
  vi.spyOn(c, "createOwnedContainer").mockResolvedValue(container);
  vi.spyOn(c, "finishContainer").mockResolvedValue(undefined);
  const ready = vi.spyOn(c, "ready").mockResolvedValue(baseId);
  const remove = vi.fn(
    async (id: string, _options?: Docker.ImageRemoveOptions) => [
      { Deleted: id },
    ],
  );
  const df = vi.fn(async () => inventory);
  c.docker = {
    df,
    getImage: (id: string) => ({
      inspect: async () => {
        if (id === baseId) return { Config: { User: "1000:1000" } };
        if (builtLabels)
          return { Config: { User: "1000:1000", Labels: builtLabels } };
        throw Object.assign(new Error("映像不存在"), { statusCode: 404 });
      },
      remove: (options?: Docker.ImageRemoveOptions) => remove(id, options),
    }),
  } as unknown as Docker;
  vi.spyOn(c, "assertNetwork").mockResolvedValue(undefined);
  return {
    c,
    request,
    image,
    inventory,
    old,
    baseId,
    commit,
    ready,
    remove,
    df,
  };
}

it("建立新映像後，只刪同專案同套件、基底不同且沒有容器使用的映像", async () => {
  const f = fixture();
  const result = await derivedImage(f.c, f.request);
  expect(f.commit).toHaveBeenCalledWith(
    expect.objectContaining({
      _body: expect.objectContaining({
        Labels: expect.objectContaining({
          "io.agentflow.base": f.baseId,
          "io.agentflow.derived-packages": packageIdentity(f.request.items),
        }),
      }),
    }),
  );
  expect(f.remove.mock.calls).toEqual([[f.old.Id, { noprune: true }]]);
  expect(result.cleanup).toEqual({
    removed: 1,
    estimatedBytes: 2 * 1024 ** 3,
    issues: [],
  });
  f.df.mockClear();
  const reused = await derivedImage(f.c, f.request);
  expect(reused).toMatchObject({ image: result.image, reused: true });
  expect(reused.cleanup).toBeUndefined();
  expect(f.df).not.toHaveBeenCalled();
});

it("舊映像刪除失敗時記下原因，繼續清理且回傳新映像", async () => {
  const f = fixture();
  const another = f.image("another-old");
  f.inventory.Images.push(another);
  f.remove.mockRejectedValueOnce(new Error("映像剛被容器引用"));
  const result = await derivedImage(f.c, f.request);
  expect(result).toMatchObject({ image: expect.any(String), exitCode: 0 });
  expect(f.remove).toHaveBeenLastCalledWith(another.Id, { noprune: true });
  expect(result.cleanup).toMatchObject({
    removed: 1,
    estimatedBytes: 2 * 1024 ** 3,
    issues: [expect.stringContaining("部分舊衍生映像未能清除")],
  });
});

it("安裝期間基底標籤移到其他映像時，保留其餘衍生映像", async () => {
  const f = fixture();
  f.ready
    .mockResolvedValueOnce(f.baseId)
    .mockResolvedValueOnce("sha256:new-derived")
    .mockResolvedValueOnce("sha256:next-base");
  const result = await derivedImage(f.c, f.request);
  expect(result.image).toBeTruthy();
  expect(result.cleanup).toBeUndefined();
  expect(f.remove).not.toHaveBeenCalled();
});

it("Docker 盤點失敗時回傳已建好的映像與清理提示", async () => {
  const f = fixture();
  f.df.mockRejectedValueOnce(new Error("Docker 未回應"));
  const result = await derivedImage(f.c, f.request);
  expect(result).toMatchObject({
    image: expect.any(String),
    exitCode: 0,
    cleanup: {
      removed: 0,
      issues: [expect.stringContaining("舊衍生映像清理未完成")],
    },
  });
  expect(f.remove).not.toHaveBeenCalled();
});
