import Docker from "dockerode";
import type { RunEvent } from "../shared/observation.js";
import { PassThrough, type Duplex } from "node:stream";
import { request, type ClientRequest } from "node:http";
import { buffer } from "node:stream/consumers";
import { pack } from "tar-stream";
import { AppError } from "./policy.js";
import { instanceName } from "./config.js";
const cleanupDelay = () => new Promise((resolve) => setTimeout(resolve, 100));
export const COLLECT_OUTPUT_BYTES = 16 * 1024 * 1024;
const nugetFeedPath = "/opt/agentflow/nuget-feed";
/** 擁有者提供的環境資料（例如資料庫結構快照）；所有階段唯讀掛載。 */
export const environmentPath = "/agentflow/env";
// 單一截止時間涵蓋整個生命週期；晚到的 create/attach 結果只能清理，不能續跑。
export class ContainerDeadline {
  private readonly ends: number;
  private readonly timer: NodeJS.Timeout;
  private reason?: AppError;
  private closed = false;
  private reject!: (error: AppError) => void;
  private readonly interrupted = new Promise<never>((_resolve, reject) => {
    this.reject = reject;
  });
  constructor(
    timeoutMs: number,
    private readonly timeoutError: AppError,
    private readonly onClose: () => void = () => {},
  ) {
    this.ends = Date.now() + Math.max(1, timeoutMs);
    this.timer = setTimeout(
      () => this.stop(timeoutError),
      Math.max(1, timeoutMs),
    );
    void this.interrupted.catch(() => {});
  }
  stop(error: AppError) {
    if (!this.reason) {
      this.reason = error;
      this.reject(error);
    }
  }
  check() {
    if (Date.now() >= this.ends) this.stop(this.timeoutError);
    if (this.reason) throw this.reason;
  }
  remaining() {
    this.check();
    return Math.max(1, this.ends - Date.now());
  }
  async run<T>(operation: () => Promise<T>, late?: (value: T) => unknown) {
    this.check();
    const pending = Promise.resolve()
      .then(() => {
        this.check();
        return operation();
      })
      .then(
        async (value) => {
          if (this.reason || Date.now() >= this.ends) {
            try {
              await late?.(value);
            } catch {
              console.warn(
                "晚到的工作資源清理未完成，將於下次執行環境清理時重試",
              );
            }
          }
          this.check();
          return value;
        },
        (error) => {
          this.check();
          throw error;
        },
      );
    return Promise.race([pending, this.interrupted]);
  }
  close() {
    clearTimeout(this.timer);
    if (!this.closed) {
      this.closed = true;
      this.onClose();
    }
  }
}
/** 執行器接受的最低工作映像版本；與 worker/Dockerfile 的 io.agentflow.worker-rev 同步。 */
export const WORKER_REV = "2026-11-13.2";
export const containerPolicy = (
  volume: string,
  network: string,
  readonly = false,
) => ({
  Binds: [`${volume}:/workspace${readonly ? ":ro" : ""}`],
  ReadonlyRootfs: true,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges:true"],
  Memory: 2 * 1024 * 1024 * 1024,
  NanoCpus: 2_000_000_000,
  PidsLimit: 512,
  NetworkMode: network,
  Tmpfs: { "/tmp": "rw,nosuid,size=512m,mode=1777" },
  AutoRemove: false,
});
export class Containers {
  docker: Docker;
  readonly instance: string;
  private removals = new Map<string, Promise<void>>();
  private creations = new Map<string, Set<Promise<Docker.Container>>>();
  private active = new Map<string, Set<ContainerDeadline>>();
  private provided = new Set<string>();
  constructor(instance = instanceName()) {
    this.instance = instanceName(instance);
    this.docker = new Docker(
      process.platform === "win32"
        ? { socketPath: "//./pipe/dockerDesktopLinuxEngine" }
        : undefined,
    );
  }
  labels(runId?: string): Record<string, string> {
    return {
      "io.agentflow.managed": "true",
      "io.agentflow.instance": this.instance,
      ...(runId ? { "io.agentflow.run": runId } : {}),
    };
  }
  begin(runId: string, timeoutMs: number, error: AppError) {
    this.volume(runId);
    const active = this.active.get(runId) ?? new Set<ContainerDeadline>();
    this.active.set(runId, active);
    const deadline = new ContainerDeadline(timeoutMs, error, () => {
      active.delete(deadline);
      if (!active.size) this.active.delete(runId);
    });
    active.add(deadline);
    return deadline;
  }
  /** 此執行器正在建立或執行這個 run 的容器；磁碟清理不得碰它。 */
  isActive(runId: string) {
    return this.active.has(runId) || this.creations.has(runId);
  }
  private stopRun(runId: string) {
    for (const deadline of this.active.get(runId) ?? [])
      deadline.stop(new AppError(409, "工作已取消"));
  }
  private async exitDiagnostic(
    container: Docker.Container,
    exitCode: number,
    deadline: ContainerDeadline,
  ) {
    if (exitCode === 0) return "";
    // wait 已完成不代表 OOM 旗標必然可見；僅重讀同一容器，最多等兩秒。
    // 137 也可能來自其他終止原因，沒有 Docker 旗標就不能宣稱 OOM。
    const inspection = new ContainerDeadline(
      Math.min(2000, deadline.remaining()),
      new AppError(503, "容器退出診斷逾時"),
    );
    let info: Docker.ContainerInspectInfo | undefined;
    try {
      do {
        info = await deadline.run(() =>
          inspection.run(() => container.inspect()),
        );
        if (info.State.OOMKilled || exitCode !== 137) break;
        await deadline.run(() => inspection.run(cleanupDelay));
      } while (true);
    } catch {
      // 診斷本身失敗保留原退出碼與輸出；取消或總期限仍必須中止工作。
      deadline.check();
    } finally {
      inspection.close();
    }
    if (info?.State.OOMKilled) {
      const memory = info.HostConfig?.Memory;
      const limit =
        typeof memory === "number" && Number.isSafeInteger(memory) && memory > 0
          ? `；記憶體限制：${Number((memory / 1024 / 1024).toFixed(2))} MiB`
          : "";
      return `容器因記憶體不足（OOM）終止${limit}。`;
    }
    return exitCode === 137
      ? "容器以退出碼 137 結束；Docker 未確認記憶體不足（OOM），請查看執行紀錄。"
      : "";
  }
  network(name: string) {
    if (name === "none" || this.instance === "production") return name;
    if (name === "bridge") return `${this.instance}_source`;
    if (/^line-agentflow_(workers|install|ai|subscription|open)$/.test(name))
      return name.replace("line-agentflow", this.instance);
    if (
      ["workers", "install", "ai", "subscription", "source", "open"].some(
        (suffix) => name === `${this.instance}_${suffix}`,
      )
    )
      return name;
    throw new AppError(400, "驗收工作禁止使用其他環境的網路");
  }
  volume(runId: string) {
    if (!/^[a-f0-9-]{36}$/.test(runId))
      throw new AppError(400, "執行識別碼錯誤");
    return this.instance === "production"
      ? `agentflow-job-${runId}`
      : `agentflow-${this.instance}-job-${runId}`;
  }
  private async nugetFeedMount(
    deadline: ContainerDeadline,
  ): Promise<Docker.MountSettings | undefined> {
    const name = `agentflow-${this.instance}-nuget-feed-v1`;
    const feed = await deadline.run(() =>
      this.docker
        .getVolume(name)
        .inspect()
        .catch((error) => {
          if (error.statusCode === 404) return undefined;
          throw error;
        }),
    );
    if (
      feed?.Driver !== "local" ||
      feed.Labels?.["io.agentflow.nuget-feed"] !== "v1" ||
      feed.Labels["io.agentflow.instance"] !== this.instance ||
      Object.keys(feed.Options ?? {}).length > 0
    )
      return;
    return {
      Type: "volume",
      Source: name,
      Target: nugetFeedPath,
      ReadOnly: true,
      VolumeOptions: {
        NoCopy: true,
        Labels: {},
        DriverConfig: { Name: "local", Options: {} },
      },
    };
  }
  async ensureVolume(
    name: string,
    runId?: string,
    sourceCache = false,
    deadline?: ContainerDeadline,
  ) {
    const labels = {
      ...this.labels(runId),
      ...(sourceCache ? { "io.agentflow.source-cache": "v1" } : {}),
    };
    const create = () =>
      this.docker.createVolume({ Name: name, Labels: labels });
    // createVolume 也可能回傳既有工作卷；晚回應不可刪除其中保留的差異證據。
    if (deadline) await deadline.run(create);
    else await create();
    const inspect = () => this.docker.getVolume(name).inspect();
    const actual =
      (await (deadline ? deadline.run(inspect) : inspect())).Labels ?? {};
    // 升級前正式快取具有種類標記但沒有 instance，只容許沿用；清理永遠不認領舊資源。
    const legacyCache =
      sourceCache &&
      this.instance === "production" &&
      !actual["io.agentflow.instance"] &&
      actual["io.agentflow.source-cache"] === "v1";
    if (
      !legacyCache &&
      (actual["io.agentflow.instance"] !== this.instance ||
        actual["io.agentflow.managed"] !== "true" ||
        (runId && actual["io.agentflow.run"] !== runId))
    )
      throw new AppError(409, `資源不屬於此執行環境：${name}`);
  }
  async sourceNetwork(deadline?: ContainerDeadline) {
    const name = this.network("bridge");
    if (this.instance === "production") return name;
    try {
      const inspect = () => this.docker.getNetwork(name).inspect();
      await (deadline ? deadline.run(inspect) : inspect());
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const create = () =>
        this.docker.createNetwork({
          Name: name,
          Driver: "bridge",
          Labels: this.labels(),
        });
      await (deadline ? deadline.run(create) : create());
    }
    const inspect = () => this.docker.getNetwork(name).inspect();
    const actual = await (deadline ? deadline.run(inspect) : inspect());
    if (actual.Labels?.["io.agentflow.instance"] !== this.instance)
      throw new AppError(409, "專案快取網路不屬於此執行環境");
    return name;
  }
  // 完全開放模式使用的一般 bridge 網路：可連網際網路與主機所在內網，需要時才建立。
  async ensureOpenNetwork(name: string) {
    const exists = await this.docker
      .getNetwork(name)
      .inspect()
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await this.docker
      .createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: { "io.agentflow.instance": this.instance },
      })
      .catch((e: { statusCode?: number }) => {
        if (e.statusCode !== 409) throw e;
      });
  }
  async assertNetwork(name: string) {
    if (name === "none" || this.instance === "production") return;
    const actual = await this.docker.getNetwork(name).inspect();
    if (actual.Labels?.["io.agentflow.instance"] !== this.instance)
      throw new AppError(409, "工作網路不屬於此執行環境");
  }
  async ready(image: string) {
    const meta = await this.docker.getImage(image).inspect();
    if (meta.Config.Labels?.["io.agentflow.worker"] !== "v1")
      throw new AppError(
        400,
        "請使用由 worker/Dockerfile 建立、具 v1 標記的映像",
      );
    const rev = meta.Config.Labels?.["io.agentflow.worker-rev"] ?? "";
    if (rev < WORKER_REV)
      throw new AppError(
        400,
        `工作映像 ${image} 版本過舊（${rev || "未標示"}，需要 ${WORKER_REV} 以後），缺少目前的工作程式與工具；請改用 line-agentflow-worker:local，或以最新 worker/Dockerfile 重建`,
      );
    return meta.Id;
  }
  async createOwnedContainer(
    runId: string,
    options: Docker.ContainerCreateOptions,
    deadline: ContainerDeadline,
  ) {
    return deadline.run(
      () => {
        const pending = this.docker.createContainer(options);
        const creates =
          this.creations.get(runId) ?? new Set<Promise<Docker.Container>>();
        this.creations.set(runId, creates);
        creates.add(pending);
        const settled = () => {
          creates.delete(pending);
          if (!creates.size) this.creations.delete(runId);
        };
        void pending.then(settled, settled);
        return pending;
      },
      (late) => this.removeOwnedContainer(late.id, runId),
    );
  }
  async removeOwnedContainer(id: string, runId?: string, timeoutMs = 15000) {
    const key = `${id}:${runId ?? ""}`;
    const pending = this.removals.get(key);
    if (pending) return pending;
    const remove = async () => {
      const container = this.docker.getContainer(id),
        deadline = new ContainerDeadline(
          timeoutMs,
          new AppError(503, "容器清理逾時，尚未移除的工作資源已保留供重試"),
        );
      try {
        for (;;) {
          const info = await deadline
            .run(() => container.inspect())
            .catch((error: { statusCode?: number }) => {
              if (error.statusCode === 404) return undefined;
              throw error;
            });
          if (!info) return;
          const labels = info.Config.Labels ?? {};
          if (
            labels["io.agentflow.instance"] !== this.instance ||
            labels["io.agentflow.managed"] !== "true" ||
            (runId && labels["io.agentflow.run"] !== runId)
          )
            throw new AppError(409, "拒絕清除不屬於此執行環境的容器");
          try {
            await deadline.run(() => container.remove({ force: true }));
          } catch (error) {
            const code = (error as { statusCode?: number }).statusCode;
            if (code === 404) return;
            if (code !== 409) throw error;
          }
          // Docker 409 可能表示另一條取消／逾時路徑仍在移除；必須等 inspect 404。
          await deadline.run(cleanupDelay);
        }
      } finally {
        deadline.close();
      }
    };
    const promise = remove();
    this.removals.set(key, promise);
    try {
      await promise;
    } finally {
      this.removals.delete(key);
    }
  }
  async finishContainer(id: string, runId: string, failure?: unknown) {
    try {
      await this.removeOwnedContainer(id, runId);
    } catch (cleanupError) {
      if (failure instanceof Error) {
        // 清理錯誤不能蓋掉原始逾時／執行錯誤，且不洩漏 Docker 回應內容。
        throw new AppError(
          (failure as { statusCode?: number }).statusCode ?? 500,
          `${failure.message}；容器清理尚未完成，請重試清理`,
        );
      }
      throw cleanupError;
    }
  }
  async phase(
    runId: string,
    image: string,
    cmd: string[],
    network = "none",
    input?: string,
    timeoutMs = 1800000,
    readonly = false,
    mount = true,
    observe?: (event: Partial<RunEvent> & { kind: string }) => void,
    options?: {
      output?: "collect";
      extraNetworks?: string[];
      nugetFeed?: boolean;
      /** 收集差異時排除的建置產物規則（已套用專案增減）。 */
      collectExclude?: string[];
    },
  ) {
    const volume = this.volume(runId);
    const deadline = this.begin(
      runId,
      Math.max(1000, timeoutMs),
      new AppError(408, "執行超過時間限制"),
    );
    let owned: Docker.Container | undefined,
      stream: Duplex | undefined,
      failure: unknown,
      attachRequest: ClientRequest | undefined,
      acceptingAttachment = true;
    try {
      const imageId = await deadline.run(() => this.ready(image));
      if (mount) {
        await deadline.run(() =>
          this.ensureVolume(volume, runId, false, deadline),
        );
        await deadline.run(() =>
          this.ensureVolume(`${volume}-baseline`, runId, false, deadline),
        );
      }
      const env = [
        "HOME=/tmp/home",
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_GLOBAL=/dev/null",
      ];
      // 安裝階段使用套件出口；訂閱工作只使用內部固定代理，不注入外網 proxy。
      const proxy = {
        "line-agentflow_install": "http://egress:3128",
      }[network.replace(`${this.instance}_`, "line-agentflow_")];
      network = this.network(network);
      if (network.endsWith("_open")) {
        const open = network;
        await deadline.run(() => this.ensureOpenNetwork(open));
      }
      await deadline.run(() => this.assertNetwork(network));
      if (proxy)
        env.push(
          `HTTP_PROXY=${proxy}`,
          `HTTPS_PROXY=${proxy}`,
          `http_proxy=${proxy}`,
          `https_proxy=${proxy}`,
          `npm_config_proxy=${proxy}`,
          `npm_config_https_proxy=${proxy}`,
          "NO_PROXY=",
        );
      const nugetFeed =
        mount && options?.nugetFeed
          ? await this.nugetFeedMount(deadline)
          : undefined;
      if (nugetFeed)
        env.push(`RestoreAdditionalProjectSources=${nugetFeedPath}`);
      const environment = mount && this.provided.has(runId);
      if (environment) env.push(`AGENTFLOW_ENV_DIR=${environmentPath}`);
      if (options?.collectExclude?.length)
        env.push(
          `AGENTFLOW_COLLECT_EXCLUDE=${JSON.stringify(options.collectExclude)}`,
        );
      const container = await this.createOwnedContainer(
        runId,
        {
          Image: imageId,
          User: "1000:1000",
          WorkingDir: "/workspace",
          Entrypoint: cmd,
          Cmd: [],
          Env: env,
          AttachStdin: !!input,
          AttachStdout: true,
          AttachStderr: true,
          OpenStdin: !!input,
          StdinOnce: !!input,
          Labels: this.labels(runId),
          HostConfig: {
            ...containerPolicy(volume, network, readonly),
            ...(nugetFeed ? { Mounts: [nugetFeed] } : {}),
            Binds: mount
              ? [
                  `${volume}:/workspace${readonly ? ":ro" : ""}`,
                  `${volume}-baseline:/baseline:ro`,
                  ...(environment
                    ? [`${volume}-env:${environmentPath}:ro`]
                    : []),
                ]
              : [],
          },
        },
        deadline,
      );
      owned = container;
      observe?.({ kind: "container", containerId: container.id });
      // 額外網路只接受本執行環境的內部套件出口，在啟動前連上。
      for (const extra of options?.extraNetworks ?? []) {
        if (!/^line-agentflow_(install|open)$/.test(extra))
          throw new AppError(400, "不允許的額外網路");
        const name = this.network(extra);
        if (extra.endsWith("_open"))
          await deadline.run(() => this.ensureOpenNetwork(name));
        await deadline.run(() => this.assertNetwork(name));
        await deadline.run(() =>
          this.docker.getNetwork(name).connect({ Container: container.id }),
        );
      }
      let pending = "";
      let output = "",
        error = "",
        outputBytes = 0,
        outputOverflow = false;
      const out = new PassThrough(),
        err = new PassThrough();
      out.setEncoding("utf8");
      err.setEncoding("utf8");
      out.on("data", (b) => {
        if (options?.output === "collect") {
          outputBytes += Buffer.byteLength(b, "utf8");
          if (outputBytes > COLLECT_OUTPUT_BYTES) {
            if (!outputOverflow) {
              outputOverflow = true;
              output = "";
              deadline.stop(
                new AppError(
                  413,
                  "成果收集輸出超過 16 MiB 傳輸上限，未回傳截斷成果",
                ),
              );
            }
          } else if (!outputOverflow) output += b;
          return;
        }
        if (output.length < 12 * 1024 * 1024) output += b.toString();
      });
      err.on("data", (b) => {
        if (!observe || !input) {
          if (error.length < 100000) error += b.toString();
          return;
        }
        pending += b.toString();
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.startsWith("AGENTFLOW_EVENT ")) {
            try {
              observe(JSON.parse(line.slice(16)));
            } catch {
              /* 不可信輸出不能影響執行 */
            }
          } else if (error.length < 100000) error += line + "\n";
        }
        if (pending.length > 24000) pending = "";
      });
      // attach 必須沒有 HTTP 內容；docker-modem 會把查詢參數寫成
      // POST 內容，競態時這段 JSON 會混進容器 stdin。
      stream = await deadline.run(
        () =>
          input
            ? new Promise<Duplex>((resolve, reject) => {
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
                  reject(new Error(`容器輸入連線失敗（${res.statusCode}）`));
                });
                req.once("error", reject);
                req.setTimeout(10000, () =>
                  req.destroy(new Error("容器輸入連線逾時")),
                );
                req.end();
              })
            : (container.attach({
                stream: true,
                stdout: true,
                stderr: true,
              }) as Promise<Duplex>),
        (late) => late.destroy(),
      );
      const drained = new Promise<void>((resolve, reject) => {
        stream!.once("end", resolve);
        stream!.once("error", reject);
      });
      // 容器退出與附加輸出送完是不同事件，先等待輸出完整再回傳。
      void drained.catch(() => {});
      this.docker.modem.demuxStream(stream, out, err);
      await deadline.run(
        () => container.start(),
        () => this.removeOwnedContainer(container.id, runId),
      );
      if (input) {
        deadline.check();
        stream.write(`${input}\n`);
      }
      const result = await deadline.run(() => container.wait());
      await deadline.run(() => drained);
      if (
        pending &&
        error.length < 100000 &&
        !pending.startsWith("AGENTFLOW_EVENT ")
      )
        error += pending;
      if (outputOverflow)
        throw new AppError(
          413,
          "成果收集輸出超過 16 MiB 傳輸上限，未回傳截斷成果",
        );
      const diagnostic = await this.exitDiagnostic(
        container,
        result.StatusCode,
        deadline,
      );
      if (diagnostic)
        error += `${error.endsWith("\n") || !error ? "" : "\n"}${diagnostic}`;
      return { exitCode: result.StatusCode, stdout: output, stderr: error };
    } catch (error) {
      failure = error;
      throw failure;
    } finally {
      acceptingAttachment = false;
      deadline.close();
      attachRequest?.destroy();
      stream?.destroy();
      if (owned) await this.finishContainer(owned.id, runId, failure);
    }
  }
  async prepare(
    runId: string,
    image: string,
    archive: Buffer | NodeJS.ReadableStream,
  ) {
    const volume = this.volume(runId);
    await this.ready(image);
    await this.ensureVolume(volume, runId);
    await this.ensureVolume(`${volume}-baseline`, runId);
    const helper = await this.docker.createContainer({
      Image: image,
      User: "0:0",
      Entrypoint: [
        "sh",
        "-c",
        'set -eu; mkdir -p /tmp/incoming; for source in /tmp/incoming/*; do if [ -d "$source" ]; then cp -a "$source/." /workspace/; fi; done; chown -R 1000:1000 /workspace',
      ],
      Cmd: [],
      Labels: this.labels(runId),
      HostConfig: {
        NetworkMode: "none",
        Binds: [`${volume}:/workspace`],
        CapDrop: ["ALL"],
        // 複製至已交給工作使用者的目錄時，cp -a 需要保留目錄時間。
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    let prepareFailure: unknown;
    try {
      await helper.start();
      if ((await helper.wait()).StatusCode !== 0)
        throw new Error("專案暫存目錄準備失敗");
      await helper.putArchive(archive, { path: "/tmp/incoming" });
      await helper.start();
      if ((await helper.wait()).StatusCode !== 0)
        throw new Error("專案檔案或工作使用者權限準備失敗");
    } catch (error) {
      prepareFailure = error;
      throw error;
    } finally {
      await this.finishContainer(helper.id, runId, prepareFailure);
    }
    const result = await this.phase(runId, image, [
      "sh",
      "-c",
      'set -eu; git -c core.hooksPath=/dev/null init -q; git -c core.hooksPath=/dev/null add -A; git -c core.hooksPath=/dev/null -c user.name=LINE-AgentFlow -c user.email=agentflow@localhost commit -qm "記錄工作基底"',
    ]);
    if (result.exitCode !== 0)
      throw new AppError(500, `專案準備失敗：${result.stderr.slice(-1000)}`);
    const snapshot = await this.docker.createContainer({
      Image: image,
      User: "0:0",
      Entrypoint: [
        "sh",
        "-c",
        "cp -a /workspace/.git/. /baseline/; chmod -R a+rX /baseline",
      ],
      Cmd: [],
      Labels: this.labels(runId),
      HostConfig: {
        NetworkMode: "none",
        Binds: [`${volume}:/workspace:ro`, `${volume}-baseline:/baseline`],
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    prepareFailure = undefined;
    try {
      await snapshot.start();
      const done = await snapshot.wait();
      if (done.StatusCode !== 0)
        throw new AppError(500, "無法記錄唯讀工作基底");
    } catch (error) {
      prepareFailure = error;
      throw error;
    } finally {
      await this.finishContainer(snapshot.id, runId, prepareFailure);
    }
  }
  /** 把環境資料寫進這次執行專用的資料卷；之後每個階段唯讀掛載在 environmentPath。 */
  async provide(
    runId: string,
    image: string,
    files: { path: string; content: string }[],
  ) {
    const volume = `${this.volume(runId)}-env`;
    await this.ready(image);
    await this.ensureVolume(volume, runId);
    const archive = pack();
    for (const file of files) archive.entry({ name: file.path }, file.content);
    archive.finalize();
    const helper = await this.docker.createContainer({
      Image: image,
      User: "0:0",
      Entrypoint: ["sh", "-c", `chmod -R a+rX ${environmentPath}`],
      Cmd: [],
      Labels: this.labels(runId),
      HostConfig: {
        NetworkMode: "none",
        Binds: [`${volume}:${environmentPath}`],
        CapDrop: ["ALL"],
        CapAdd: ["DAC_OVERRIDE", "FOWNER"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    let failure: unknown;
    try {
      await helper.putArchive(
        await buffer(archive as unknown as AsyncIterable<Buffer>),
        { path: environmentPath },
      );
      await helper.start();
      if ((await helper.wait()).StatusCode !== 0)
        throw new AppError(500, "環境資料準備失敗");
      this.provided.add(runId);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.finishContainer(helper.id, runId, failure);
    }
  }
  /** 把 GitHub 原始碼封存解開到環境資料卷的子目錄（跨專案查詢用），之後唯讀掛載。 */
  async provideArchive(
    runId: string,
    image: string,
    directory: string,
    archive: Buffer | NodeJS.ReadableStream,
  ) {
    if (
      !/^projects\/[A-Za-z0-9._-]+$/.test(directory) ||
      directory.includes("..")
    )
      throw new AppError(400, "環境資料目錄名稱無效");
    const volume = `${this.volume(runId)}-env`;
    await this.ready(image);
    await this.ensureVolume(volume, runId);
    const helper = await this.docker.createContainer({
      Image: image,
      User: "0:0",
      Env: [`TARGET=${environmentPath}/${directory}`],
      Entrypoint: [
        "sh",
        "-c",
        `set -eu; mkdir -p /tmp/incoming "$TARGET"; for source in /tmp/incoming/*; do if [ -d "$source" ]; then cp -a "$source/." "$TARGET/"; fi; done; chmod -R a+rX ${environmentPath}`,
      ],
      Cmd: [],
      Labels: this.labels(runId),
      HostConfig: {
        NetworkMode: "none",
        Binds: [`${volume}:${environmentPath}`],
        CapDrop: ["ALL"],
        // cp -a 以 root 保留檔案擁有者與時間需要 CHOWN。
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    let failure: unknown;
    try {
      await helper.start();
      if ((await helper.wait()).StatusCode !== 0)
        throw new AppError(500, "環境資料準備失敗");
      // putArchive 會自動解開 gzip 壓縮的 tar（GitHub tarball）。
      await helper.putArchive(archive, { path: "/tmp/incoming" });
      await helper.start();
      if ((await helper.wait()).StatusCode !== 0)
        throw new AppError(500, "相關專案原始碼準備失敗");
      this.provided.add(runId);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.finishContainer(helper.id, runId, failure);
    }
  }
  async cancel(runId: string, sharedDeadline?: ContainerDeadline) {
    this.volume(runId);
    this.stopRun(runId);
    const deadline =
      sharedDeadline ??
      new ContainerDeadline(
        15000,
        new AppError(503, "取消清理逾時，工作資源已保留供重試"),
      );
    try {
      const containers = await deadline.run(() =>
        this.docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: [
              `io.agentflow.run=${runId}`,
              "io.agentflow.managed=true",
              `io.agentflow.instance=${this.instance}`,
            ],
          }),
        }),
      );
      for (const c of containers)
        await deadline.run(() =>
          this.removeOwnedContainer(c.Id, runId, deadline.remaining()),
        );
    } finally {
      if (!sharedDeadline) deadline.close();
    }
  }
  async dispose(runId: string) {
    this.stopRun(runId);
    const deadline = new ContainerDeadline(
      15000,
      new AppError(503, "工作資源清理逾時，尚未移除的資源已保留供重試"),
    );
    try {
      // create 尚未回覆時先刪卷，可能讓晚到 create 隱含重建無標籤卷。
      // Docker 失聯時保留現有工作卷供明確重試，不猜測移除。
      const pending = [...(this.creations.get(runId) ?? [])];
      if (pending.length) await deadline.run(() => Promise.allSettled(pending));
      await deadline.run(() => this.cancel(runId, deadline));
      for (const name of [
        this.volume(runId),
        `${this.volume(runId)}-baseline`,
        ...(this.provided.delete(runId) ? [`${this.volume(runId)}-env`] : []),
      ])
        await deadline.run(() =>
          this.removeOwnedVolume(name, runId, deadline.remaining()),
        );
    } finally {
      deadline.close();
    }
  }
  async removeOwnedVolume(name: string, runId: string, timeoutMs = 15000) {
    if (
      ![
        this.volume(runId),
        `${this.volume(runId)}-baseline`,
        `${this.volume(runId)}-env`,
      ].includes(name)
    )
      throw new AppError(400, "拒絕清除此工作的副本以外資料卷");
    const volume = this.docker.getVolume(name);
    const deadline = new ContainerDeadline(
      timeoutMs,
      new AppError(503, "工作資料卷清理逾時，已保留供重試清理"),
    );
    try {
      for (;;) {
        const info = await deadline
          .run(() => volume.inspect())
          .catch((error: { statusCode?: number }) => {
            if (error.statusCode === 404) return undefined;
            throw error;
          });
        if (!info) break;
        if (
          info.Labels?.["io.agentflow.instance"] !== this.instance ||
          info.Labels?.["io.agentflow.run"] !== runId ||
          info.Labels?.["io.agentflow.managed"] !== "true"
        )
          throw new AppError(409, `拒絕清除來源不明的資料卷：${name}`);
        try {
          await deadline.run(() => volume.remove());
          break;
        } catch (error) {
          const code = (error as { statusCode?: number }).statusCode;
          if (code === 404) break;
          if (code !== 409) throw error;
          // 只處理此 instance/run 的容器；其他環境若仍掛載，不得代為移除。
          await deadline.run(() => this.cancel(runId, deadline));
          await deadline.run(cleanupDelay);
        }
      }
    } finally {
      deadline.close();
    }
  }
  async cleanup() {
    for (const runId of this.active.keys()) this.stopRun(runId);
    const deadline = new ContainerDeadline(
      15000,
      new AppError(503, "執行環境清理逾時，尚未移除的資源已保留供重試"),
    );
    try {
      const containers = await deadline.run(() =>
        this.docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: [
              "io.agentflow.managed=true",
              `io.agentflow.instance=${this.instance}`,
            ],
          }),
        }),
      );
      for (const c of containers)
        await deadline.run(() =>
          this.removeOwnedContainer(c.Id, undefined, deadline.remaining()),
        );
    } finally {
      deadline.close();
    }
  }
}
