import { createHash } from "node:crypto";
import { request, type ClientRequest } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { z } from "zod";
import { Containers, containerPolicy } from "./containers.js";
import type Docker from "dockerode";
import { AppError } from "./policy.js";
import { instanceName } from "./config.js";

export const SourceAccess = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  repositoryId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  token: z.string().min(1).max(2000),
});
export type SourceAccess = z.infer<typeof SourceAccess>;
export interface SourceReport {
  cache: "cold" | "hit" | "updated";
  sha: string;
  snapshotHit: boolean;
  fetchMs: number;
  snapshotMs: number;
  copyMs: number;
  totalMs: number;
  addedObjectBytes: number;
}
export function sourceVolume(
  source: Pick<SourceAccess, "repo" | "repositoryId" | "installationId">,
  instance = instanceName(),
) {
  instanceName(instance);
  const key = createHash("sha256")
    .update(
      `${source.installationId}:${source.repositoryId}:${source.repo.toLowerCase()}`,
    )
    .digest("hex")
    .slice(0, 32);
  return instance === "production"
    ? `agentflow-source-v1-${key}`
    : `agentflow-${instance}-source-v1-${key}`;
}
export class SourceCache {
  constructor(
    private containers: Containers,
    private image = process.env.SOURCE_CACHE_IMAGE ??
      "line-agentflow-source:local",
  ) {}
  async prepare(
    runId: string,
    workerImage: string,
    input: SourceAccess,
    timeoutMs = 1800000,
  ): Promise<SourceReport> {
    const source = SourceAccess.parse(input);
    const c = this.containers,
      volume = c.volume(runId),
      cache = sourceVolume(source, c.instance);
    const deadline = c.begin(
      runId,
      timeoutMs,
      new AppError(408, "專案快取準備超過時間限制"),
    );
    let owned: Docker.Container | undefined,
      stream: Duplex | undefined,
      failure: unknown,
      attachRequest: ClientRequest | undefined,
      acceptingAttachment = true;
    try {
      await deadline.run(() => c.ready(workerImage));
      const image = await deadline.run(() =>
        c.docker.getImage(this.image).inspect(),
      );
      if (image.Config.Labels?.["io.agentflow.source"] !== "v1")
        throw new AppError(
          503,
          "請先建立 infra/source/Dockerfile 專案快取工具映像",
        );
      for (const name of [volume, `${volume}-baseline`, cache])
        await deadline.run(() =>
          c.ensureVolume(
            name,
            name === cache ? undefined : runId,
            name === cache,
            deadline,
          ),
        );
      const network = await deadline.run(() => c.sourceNetwork(deadline));
      const container = await c.createOwnedContainer(
        runId,
        {
          Image: image.Id,
          User: "0:0",
          AttachStdin: true,
          OpenStdin: true,
          StdinOnce: true,
          AttachStdout: true,
          AttachStderr: true,
          Labels: c.labels(runId),
          HostConfig: {
            ...containerPolicy(volume, network),
            CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
            Binds: [
              `${cache}:/cache`,
              `${volume}:/workspace`,
              `${volume}-baseline:/baseline`,
            ],
          },
        },
        deadline,
      );
      owned = container;
      // 憑證只經 stdin 傳給可信工具，不放 Docker inspect 的環境變數／參數。
      stream = await deadline.run(
        () =>
          new Promise<Duplex>((resolve, reject) => {
            const req = request({
              socketPath:
                process.platform === "win32"
                  ? "//./pipe/dockerDesktopLinuxEngine"
                  : "/var/run/docker.sock",
              path: `/containers/${container.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`,
              method: "POST",
              headers: {
                Connection: "Upgrade",
                Upgrade: "tcp",
                "Content-Length": "0",
              },
            });
            attachRequest = req;
            req.once("upgrade", (_res, socket, head) => {
              try {
                if (!acceptingAttachment) {
                  socket.destroy();
                  return;
                }
                deadline.check();
              } catch {
                socket.destroy();
                return;
              }
              socket.setTimeout(0);
              if (head.length) socket.unshift(head);
              resolve(socket);
            });
            req.once("response", (res) => {
              res.resume();
              reject(new Error("專案快取輸入連線失敗"));
            });
            req.once("error", reject);
            req.setTimeout(10000, () =>
              req.destroy(new Error("專案快取輸入逾時")),
            );
            req.end();
          }),
        (late) => late.destroy(),
      );
      const out = new PassThrough(),
        err = new PassThrough();
      let stdout = "",
        stderr = "";
      out.on("data", (b) => {
        if (stdout.length < 10000) stdout += b;
      });
      err.on("data", (b) => {
        if (stderr.length < 4000) stderr += b;
      });
      c.docker.modem.demuxStream(stream, out, err);
      const drained = new Promise<void>((resolve, reject) => {
        stream!.once("end", resolve);
        stream!.once("error", reject);
      });
      void drained.catch(() => {});
      await deadline.run(
        () => container.start(),
        () => c.removeOwnedContainer(container.id, runId),
      );
      deadline.check();
      stream.write(`${JSON.stringify(source)}\n`);
      const result = await deadline.run(() => container.wait());
      await deadline.run(() => drained);
      if (result.StatusCode !== 0)
        throw new AppError(
          502,
          `專案快取準備失敗：${stderr.split(source.token).join("[已隱藏]")}`,
        );
      return JSON.parse(stdout) as SourceReport;
    } catch (error) {
      failure = error;
      throw failure;
    } finally {
      acceptingAttachment = false;
      deadline.close();
      attachRequest?.destroy();
      stream?.destroy();
      if (owned) await c.finishContainer(owned.id, runId, failure);
    }
  }
}
