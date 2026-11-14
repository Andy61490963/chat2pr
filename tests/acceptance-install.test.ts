import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Containers } from "../server/containers.js";
import { derivedImage, derivedRepository } from "../server/derived-image.js";
import { applyEgress } from "../server/egress.js";
import {
  DEFAULT_EGRESS_DOMAINS,
  type InstallItem,
} from "../shared/install-plan.js";

/**
 * 驗收（需要網路與新版 egress 映像）：
 *   docker build -t <臨時標籤> infra/egress
 *   ACCEPTANCE_EGRESS_IMAGE=<臨時標籤> npx vitest run tests/acceptance-install.test.ts
 * 在獨立的執行環境建立自己的 egress，確認白名單可即時更新、apt 經代理以 https 安裝系統套件，
 * 衍生映像在無網路、非 root 的階段可用，同計畫第二次不重新下載。不碰正式 egress。
 */
const egressImage = process.env.ACCEPTANCE_EGRESS_IMAGE;
const image =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
const c = new Containers(`verify-egress-${randomUUID().slice(0, 8)}`);
const project = randomUUID();
const runs: string[] = [];
const outbound = `${c.instance}_egress-out`;
let egress: string | undefined;
const tree: InstallItem = {
  name: "tree",
  source: "https://deb.debian.org/debian",
  version: "",
  purpose: "列出專案目錄結構，產生測試報告用",
  commands: [
    "apt-get update",
    "apt-get install -y --no-install-recommends tree",
  ],
};
const build = () => {
  const runId = randomUUID();
  runs.push(runId);
  return derivedImage(c, {
    runId,
    base: image,
    projectId: project,
    branch: "main",
    items: [tree],
    domains: DEFAULT_EGRESS_DOMAINS,
    timeoutMs: 600000,
  });
};
const connect = async (target: string) => {
  const runId = randomUUID();
  runs.push(runId);
  const r = await c.phase(
    runId,
    image,
    [
      "node",
      "-e",
      `const http=require('http');const r=http.request({host:'egress',port:3128,method:'CONNECT',path:${JSON.stringify(target)}});r.on('connect',(res,s)=>{console.log(res.statusCode);s.destroy()});r.on('error',e=>{console.log('error');});r.end()`,
    ],
    "line-agentflow_install",
    undefined,
    20000,
    false,
    false,
  );
  return r.stdout.trim();
};

describe.skipIf(!egressImage)("驗收：可設定的白名單與系統套件安裝", () => {
  beforeAll(async () => {
    const labels = { "io.agentflow.instance": c.instance };
    await c.docker.createNetwork({
      Name: c.network("line-agentflow_install"),
      Driver: "bridge",
      Internal: true,
      Labels: labels,
    });
    await c.docker.createNetwork({
      Name: outbound,
      Driver: "bridge",
      Labels: labels,
    });
    const container = await c.docker.createContainer({
      Image: egressImage,
      name: `${c.instance}-egress-1`,
      Labels: {
        ...labels,
        "com.docker.compose.project": c.instance,
        "com.docker.compose.service": "egress",
      },
      HostConfig: { NetworkMode: outbound },
    });
    egress = container.id;
    await c.docker.getNetwork(c.network("line-agentflow_install")).connect({
      Container: container.id,
      EndpointConfig: { Aliases: ["egress"] },
    });
    await container.start();
    await new Promise((r) => setTimeout(r, 3000));
  }, 60000);
  afterAll(async () => {
    for (const id of runs) await c.dispose(id).catch(() => {});
    if (egress)
      await c.docker
        .getContainer(egress)
        .remove({ force: true })
        .catch(() => {});
    const images = await c.docker.listImages({
      filters: JSON.stringify({ reference: [derivedRepository(c.instance)] }),
    });
    for (const i of images)
      for (const tag of i.RepoTags ?? [])
        await c.docker
          .getImage(tag)
          .remove()
          .catch(() => {});
    for (const name of [c.network("line-agentflow_install"), outbound])
      await c.docker
        .getNetwork(name)
        .remove()
        .catch(() => {});
  }, 60000);

  it("白名單即時生效：移除 Debian 時 apt 被擋，加回後安裝成功並在之後的階段使用", async () => {
    const without = DEFAULT_EGRESS_DOMAINS.filter(
      (d) => d !== "deb.debian.org" && d !== "security.debian.org",
    );
    expect((await applyEgress(c, without)).changed).toBe(true);
    expect(await connect("deb.debian.org:443")).toBe("403");
    const blocked = await build();
    expect(blocked.image).toBeNull();
    expect(blocked.output).toMatch(/403|Forbidden|Could not|Failed to fetch/i);

    expect((await applyEgress(c, DEFAULT_EGRESS_DOMAINS)).changed).toBe(true);
    expect((await applyEgress(c, DEFAULT_EGRESS_DOMAINS)).changed).toBe(false);
    expect(await connect("deb.debian.org:443")).toBe("200");
    // 清單外、主機與非 TLS 仍拒絕。
    expect(await connect("example.org:443")).toBe("403");
    expect(await connect("host.docker.internal:443")).toBe("403");
    expect(await connect("deb.debian.org:80")).toBe("403");

    const first = await build();
    expect(first.image, first.output).toBeTruthy();
    expect(first.reused).toBe(false);
    const second = await build();
    expect(second).toMatchObject({ image: first.image, reused: true });

    const runId = randomUUID();
    runs.push(runId);
    const used = await c.phase(
      runId,
      first.image!,
      ["sh", "-c", 'echo "uid=$(id -u)"; tree --version'],
      "none",
      undefined,
      20000,
    );
    expect(used.exitCode, used.stderr).toBe(0);
    expect(used.stdout).toContain("uid=1000");
    expect(used.stdout).toMatch(/tree v\d/);
  }, 900000);
});
