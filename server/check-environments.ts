import type Docker from "dockerode";
import { request } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { AppError } from "./policy.js";
import type { Containers } from "./containers.js";
import {
  environmentsToRemove,
  type CheckEnvironmentPolicy,
  type EnvironmentFailure,
  type KeptEnvironment,
  type RemovalReason,
} from "../shared/check-environment.js";

/**
 * 定期檢查的專用環境（#19），只在主機執行器使用。
 *
 * 一個檢查一個環境：
 * - 專用內部網路（Internal，連不到網際網路與主機）；
 * - 轉接器：同時接上內部網路與對外網路，只把 7000 埠轉到這個檢查的目標 主機:連接埠；
 * - 檢查容器：只接內部網路、非 root、唯讀根目錄、無 capabilities、不掛載主機目錄或 Docker socket。
 *   連線機密在建立時經標準輸入交給容器內的程序，只存在記憶體，不寫入映像、環境變數、標籤或檔案。
 *
 * 執行完保留環境，下次同一個檢查、同一環境鍵直接重用；鍵不同、閒置逾時或超過上限才清除。
 * 執行器重啟時全部清除（機密只在記憶體，重啟後本來就接不回原本的標準輸入）。
 */

/** 執行器接受的最低檢查映像版本；與 infra/check/Dockerfile 的 io.agentflow.check-rev 同步。 */
export const CHECK_REV = "2026-11-14.1";
export const defaultCheckImage = "line-agentflow-check:local";
const forwardPort = 7000;
const requestTimeoutMs = 45000;
const readyTimeoutMs = 15000;

export type CheckKind = "sql" | "http" | "tcp";
export interface EnvironmentSpec {
  checkId: string;
  key: string;
  kind: CheckKind;
  /** 轉接器唯一的目標。 */
  target: { host: string; port: number };
  /** 建立時送進檢查容器的第一行（SQL 檢查含連線機密）。 */
  init: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface Environment {
  checkId: string;
  key: string;
  createdAt: number;
  lastUsedAt: number;
  probe: string;
  forwarder: string;
  network: string;
  stream: Duplex;
  pending: Map<number, Pending>;
  ready?: Pending;
  nextId: number;
  broken: boolean;
}

const hardened = (memoryMb: number) => ({
  ReadonlyRootfs: true,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges:true"],
  Memory: memoryMb * 1024 * 1024,
  MemorySwap: memoryMb * 1024 * 1024,
  NanoCpus: 500_000_000,
  PidsLimit: 64,
  Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m,mode=1777" },
  Binds: [] as string[],
  AutoRemove: false,
  RestartPolicy: { Name: "no" },
});

/**
 * 登記在主機本身的資料庫（localhost）在容器裡要經 Docker 的主機閘道連；其他名稱照原樣交給轉接器。
 * 只用於 SQL 檢查：HTTP／TCP 檢查仍拒絕主機本身。
 */
export const viaHostGateway = (host: string) =>
  /^(localhost|127.0.0.1|::1|[::1])$/i.test(host)
    ? "host.docker.internal"
    : host;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;

/** 把 a.b.c.d/n 切成 /28，回傳第 index 段；超出範圍回傳 undefined。 */
export function subnetSlot(pool: string, index: number) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(pool);
  if (!m) return undefined;
  const prefix = Number(m[5]);
  if (prefix > 28 || prefix < 8) return undefined;
  const base =
    ((Number(m[1]) << 24) |
      (Number(m[2]) << 16) |
      (Number(m[3]) << 8) |
      Number(m[4])) >>>
    0;
  const size = 2 ** (28 - prefix);
  if (index < 0 || index >= size) return undefined;
  const start = ((base & ~(2 ** (32 - prefix) - 1)) >>> 0) + index * 16;
  return `${start >>> 24}.${(start >>> 16) & 255}.${(start >>> 8) & 255}.${start & 255}/28`;
}

export class CheckEnvironments {
  private envs = new Map<string, Environment>();
  private failures = new Map<string, EnvironmentFailure>();
  private locks = new Map<string, Promise<void>>();
  private allocation: Promise<unknown> = Promise.resolve();
  readonly image: string;
  readonly pool: string;
  constructor(
    private readonly containers: Containers,
    options: { image?: string; pool?: string } = {},
  ) {
    this.image = options.image ?? process.env.CHECK_IMAGE ?? defaultCheckImage;
    this.pool =
      options.pool ?? process.env.CHECK_SUBNET_POOL ?? "10.213.0.0/16";
  }
  private get docker(): Docker {
    return this.containers.docker;
  }
  private get prefix() {
    const instance = this.containers.instance;
    return instance === "production"
      ? "agentflow-check"
      : `agentflow-${instance}-check`;
  }
  names(checkId: string) {
    if (!uuid.test(checkId)) throw new AppError(400, "檢查識別碼錯誤");
    return {
      network: `${this.prefix}-${checkId}`,
      probe: `${this.prefix}-${checkId}-probe`,
      forwarder: `${this.prefix}-${checkId}-forwarder`,
    };
  }
  get egressName() {
    return `${this.prefix}-egress`;
  }
  private labels(checkId: string, key: string, role: string) {
    return {
      ...this.containers.labels(),
      "io.agentflow.check": checkId,
      "io.agentflow.check-key": key,
      "io.agentflow.check-role": role,
    };
  }
  private owned(labels: Record<string, string> | undefined, checkId?: string) {
    return (
      labels?.["io.agentflow.managed"] === "true" &&
      labels["io.agentflow.instance"] === this.containers.instance &&
      !!labels["io.agentflow.check"] &&
      (!checkId || labels["io.agentflow.check"] === checkId)
    );
  }

  private async withLock<T>(checkId: string, work: () => Promise<T>) {
    const previous = this.locks.get(checkId) ?? Promise.resolve();
    let release!: () => void;
    const mine = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.locks.set(checkId, mine);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(checkId) === mine) this.locks.delete(checkId);
    }
  }

  /** 保留中的環境（看板顯示與清除判斷用）。 */
  list(): KeptEnvironment[] {
    return [...this.envs.values()]
      .filter((e) => !e.broken)
      .map((e) => ({
        checkId: e.checkId,
        key: e.key,
        createdAt: new Date(e.createdAt).toISOString(),
        lastUsedAt: new Date(e.lastUsedAt).toISOString(),
      }));
  }
  failureList(): EnvironmentFailure[] {
    return [...this.failures.values()];
  }

  /** 在該檢查的環境裡執行一次；沒有可用環境就先建立。 */
  async run(
    spec: EnvironmentSpec,
    payload: Record<string, unknown>,
    policy: CheckEnvironmentPolicy,
  ): Promise<{
    result: unknown;
    created: boolean;
    removed: { checkId: string; reason: RemovalReason }[];
  }> {
    this.names(spec.checkId);
    const current = this.envs.get(spec.checkId);
    const removed: { checkId: string; reason: RemovalReason }[] = [];
    if (!current || current.key !== spec.key || current.broken) {
      // 先騰出位置：不在持有自己的鎖時等待別的檢查，避免互相等待。
      const others = this.list().filter((e) => e.checkId !== spec.checkId);
      for (const r of environmentsToRemove(
        others,
        null,
        policy,
        Date.now(),
        1,
      )) {
        await this.remove(r.checkId);
        removed.push(r);
      }
    }
    return this.withLock(spec.checkId, async () => {
      let env = this.envs.get(spec.checkId);
      let created = false;
      if (env && (env.key !== spec.key || env.broken)) {
        await this.destroy(spec.checkId);
        env = undefined;
      }
      if (!env) {
        try {
          env = await this.create(spec);
        } catch (e) {
          this.failures.set(spec.checkId, {
            checkId: spec.checkId,
            key: spec.key,
            at: new Date().toISOString(),
            message: (e instanceof AppError
              ? e.message
              : "檢查環境建立失敗"
            ).slice(0, 300),
          });
          await this.destroy(spec.checkId).catch(() => {});
          throw e instanceof AppError
            ? e
            : new AppError(503, "檢查環境建立失敗，請稍後再試");
        }
        this.failures.delete(spec.checkId);
        created = true;
      }
      try {
        const result = await this.send(env, payload);
        return { result, created, removed };
      } finally {
        env.lastUsedAt = Date.now();
        if (env.broken) await this.destroy(spec.checkId).catch(() => {});
      }
    });
  }

  /** 立即清除一個檢查的環境（容器、轉接器與網路）。 */
  async remove(checkId: string) {
    this.names(checkId);
    return this.withLock(checkId, () => this.destroy(checkId));
  }

  /**
   * 依應用程式給的有效清單清除：清單外或環境鍵不同、閒置逾時、超過上限，以及沒有被追蹤的殘留資源。
   * valid 為 null 時只套用閒置與上限。
   */
  async sync(
    valid: Map<string, string> | null,
    policy: CheckEnvironmentPolicy,
  ): Promise<{ checkId: string; reason: RemovalReason }[]> {
    const removals = environmentsToRemove(
      this.list(),
      valid,
      policy,
      Date.now(),
    );
    for (const e of this.envs.values())
      if (e.broken && !removals.some((r) => r.checkId === e.checkId))
        removals.push({ checkId: e.checkId, reason: "broken" });
    for (const r of removals) await this.remove(r.checkId);
    if (valid)
      for (const id of this.failures.keys())
        if (valid.get(id) !== this.failures.get(id)?.key)
          this.failures.delete(id);
    await this.removeStrays();
    return removals;
  }

  /** 執行器啟動時清掉上次留下的所有檢查環境。 */
  async cleanupAll() {
    for (const id of [...this.envs.keys()]) await this.remove(id);
    await this.removeStrays(true);
  }

  /** 沒有在記憶體中追蹤、也沒有正在建立的檢查容器與網路（例如建立到一半失敗）。 */
  private async removeStrays(all = false) {
    // 容器會繼承映像的標籤，只靠標籤鍵篩選不夠；歸屬一律再由 owned() 核對（需要 managed 與 instance）。
    const filter = JSON.stringify({
      label: [
        "io.agentflow.managed=true",
        `io.agentflow.instance=${this.containers.instance}`,
      ],
    });
    const stray = (id?: string) =>
      !!id && (all || (!this.envs.has(id) && !this.locks.has(id)));
    const containers = await this.docker.listContainers({
      all: true,
      filters: filter,
    });
    for (const c of containers)
      if (this.owned(c.Labels) && stray(c.Labels["io.agentflow.check"]))
        await this.containers.removeOwnedContainer(c.Id);
    const networks = await this.docker.listNetworks({ filters: filter });
    for (const n of networks) {
      const id = n.Labels?.["io.agentflow.check"];
      if (
        this.owned(n.Labels) &&
        n.Labels?.["io.agentflow.check-role"] === "internal" &&
        stray(id)
      )
        await this.removeNetwork(n.Name, id!);
    }
  }

  private async removeNetwork(name: string, checkId: string) {
    const network = this.docker.getNetwork(name);
    const info = await network.inspect().catch((e) => {
      if (statusOf(e) === 404) return undefined;
      throw e;
    });
    if (!info) return;
    if (
      !this.owned(info.Labels, checkId) ||
      info.Labels?.["io.agentflow.check-role"] !== "internal"
    )
      throw new AppError(409, "拒絕清除不屬於此執行環境的網路");
    await network.remove().catch((e) => {
      if (statusOf(e) !== 404) throw e;
    });
  }

  /** 已持有該檢查的鎖時呼叫。 */
  private async destroy(checkId: string) {
    const env = this.envs.get(checkId);
    this.envs.delete(checkId);
    if (env) {
      env.broken = true;
      env.stream.destroy();
      for (const p of env.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError(409, "檢查環境已清除"));
      }
      env.pending.clear();
    }
    const names = this.names(checkId);
    // 依名稱與標籤找出所有屬於此檢查的容器，連同建立到一半的。
    const listed = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: [
          "io.agentflow.managed=true",
          `io.agentflow.instance=${this.containers.instance}`,
          `io.agentflow.check=${checkId}`,
        ],
      }),
    });
    for (const c of listed)
      if (this.owned(c.Labels, checkId))
        await this.containers.removeOwnedContainer(c.Id);
    await this.removeNetwork(names.network, checkId);
  }

  private async assertImage() {
    const meta = await this.docker
      .getImage(this.image)
      .inspect()
      .catch(() => undefined);
    const labels = meta?.Config.Labels ?? {};
    if (!meta || labels["io.agentflow.check-image"] !== "v1")
      throw new AppError(
        503,
        `找不到定期檢查映像 ${this.image}，請以 npm run deploy 更新（會自動建置）`,
      );
    if ((labels["io.agentflow.check-rev"] ?? "") < CHECK_REV)
      throw new AppError(
        503,
        `定期檢查映像 ${this.image} 版本過舊，請以 npm run deploy 重建`,
      );
    return meta.Id;
  }

  private async ensureEgress() {
    const name = this.egressName;
    const inspect = () => this.docker.getNetwork(name).inspect();
    let info = await inspect().catch((e) => {
      if (statusOf(e) === 404) return undefined;
      throw e;
    });
    if (!info) {
      await this.docker
        .createNetwork({
          Name: name,
          Driver: "bridge",
          // 轉接器彼此不能互連；只能往外連到各自的目標。
          Options: { "com.docker.network.bridge.enable_icc": "false" },
          Labels: {
            ...this.containers.labels(),
            "io.agentflow.check-role": "egress",
          },
        })
        .catch((e) => {
          if (statusOf(e) !== 409) throw e;
        });
      info = await inspect();
    }
    if (
      info.Labels?.["io.agentflow.instance"] !== this.containers.instance ||
      info.Labels?.["io.agentflow.check-role"] !== "egress"
    )
      throw new AppError(409, "檢查對外網路不屬於此執行環境");
    return name;
  }

  /** 專用內部網路使用自己的位址池，不佔 Docker 預設位址池（預設只有約 30 個網段）。 */
  private createInternalNetwork(checkId: string, key: string) {
    const name = this.names(checkId).network;
    const work = this.allocation.then(async () => {
      const existing = await this.docker.listNetworks({
        filters: JSON.stringify({
          label: [`io.agentflow.check-role=internal`],
        }),
      });
      const used = new Set(
        existing.flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Subnet)),
      );
      for (let index = 0, tried = 0; tried < 8; index++) {
        const subnet = subnetSlot(this.pool, index);
        if (!subnet)
          throw new AppError(
            503,
            "定期檢查網路的位址已用完，請減少保留的環境數或調整 CHECK_SUBNET_POOL",
          );
        if (used.has(subnet)) continue;
        tried++;
        try {
          await this.docker.createNetwork({
            Name: name,
            Driver: "bridge",
            Internal: true,
            Labels: this.labels(checkId, key, "internal"),
            IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
          });
          return name;
        } catch (e) {
          // 與其他網路重疊時換下一段；其他錯誤直接回報。
          if (!/overlap|in use|conflict/i.test(String((e as Error).message)))
            throw e;
        }
      }
      throw new AppError(
        503,
        "定期檢查網路位址與其他網路重疊，請調整 CHECK_SUBNET_POOL",
      );
    });
    this.allocation = work.catch(() => {});
    return work;
  }

  private async create(spec: EnvironmentSpec): Promise<Environment> {
    const imageId = await this.assertImage();
    const names = this.names(spec.checkId);
    const egress = await this.ensureEgress();
    await this.createInternalNetwork(spec.checkId, spec.key);
    const gateway = spec.target.host === "host.docker.internal";
    const forwarder = await this.docker.createContainer({
      name: names.forwarder,
      Image: imageId,
      User: "1000:1000",
      Cmd: ["node", "/opt/check/forwarder.cjs"],
      Env: [
        `TARGET_HOST=${spec.target.host}`,
        `TARGET_PORT=${spec.target.port}`,
        `MODE=${spec.kind === "tcp" ? "report" : "pipe"}`,
        `LISTEN_PORT=${forwardPort}`,
      ],
      Labels: this.labels(spec.checkId, spec.key, "forwarder"),
      HostConfig: {
        ...hardened(64),
        NetworkMode: egress,
        ...(gateway
          ? { ExtraHosts: ["host.docker.internal:host-gateway"] }
          : {}),
      },
    });
    await this.docker.getNetwork(names.network).connect({
      Container: forwarder.id,
      EndpointConfig: { Aliases: ["target"] },
    });
    await forwarder.start();
    const probe = await this.docker.createContainer({
      name: names.probe,
      Image: imageId,
      User: "1000:1000",
      Cmd: ["node", "/opt/check/agent.cjs"],
      Env: [`FORWARDER_HOST=target`, `FORWARDER_PORT=${forwardPort}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: false,
      Labels: this.labels(spec.checkId, spec.key, "probe"),
      HostConfig: { ...hardened(256), NetworkMode: names.network },
    });
    const stream = await this.attach(probe.id);
    const env: Environment = {
      checkId: spec.checkId,
      key: spec.key,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      probe: probe.id,
      forwarder: forwarder.id,
      network: names.network,
      stream,
      pending: new Map(),
      nextId: 1,
      broken: false,
    };
    this.listen(env);
    try {
      await probe.start();
      await new Promise((resolve, reject) => {
        env.ready = {
          resolve,
          reject,
          timer: setTimeout(
            () => reject(new AppError(503, "檢查環境啟動逾時")),
            readyTimeoutMs,
          ),
        };
        stream.write(`${JSON.stringify({ ...spec.init, kind: spec.kind })}\n`);
      });
    } catch (e) {
      stream.destroy();
      throw e;
    } finally {
      if (env.ready) clearTimeout(env.ready.timer);
      env.ready = undefined;
    }
    this.envs.set(spec.checkId, env);
    return env;
  }

  /** 以原始 HTTP 升級附加標準輸入（docker-modem 會把查詢參數寫進內容，見 containers.ts）。 */
  private attach(id: string) {
    return new Promise<Duplex>((resolve, reject) => {
      const req = request({
        socketPath:
          process.platform === "win32"
            ? "//./pipe/dockerDesktopLinuxEngine"
            : "/var/run/docker.sock",
        path: `/containers/${id}/attach?stream=true&stdin=true&stdout=true&stderr=true`,
        method: "POST",
        headers: {
          Connection: "Upgrade",
          Upgrade: "tcp",
          "Content-Length": "0",
        },
      });
      req.once("upgrade", (_res, socket, head) => {
        socket.setTimeout(0);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.once("response", (res) => {
        res.resume();
        reject(new AppError(503, "檢查容器連線失敗"));
      });
      req.once("error", () => reject(new AppError(503, "檢查容器連線失敗")));
      req.setTimeout(10000, () =>
        req.destroy(new AppError(503, "檢查容器連線逾時")),
      );
      req.end();
    });
  }

  private listen(env: Environment) {
    const out = new PassThrough(),
      err = new PassThrough();
    out.setEncoding("utf8");
    err.resume();
    let buffer = "";
    out.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        env.broken = true;
        env.stream.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if ("ready" in message) {
          if (message.ready === true) env.ready?.resolve(true);
          else
            env.ready?.reject(
              new AppError(
                422,
                String(message.message ?? "檢查環境初始化失敗").slice(0, 200),
              ),
            );
          continue;
        }
        const p = env.pending.get(Number(message.id));
        if (!p) continue;
        env.pending.delete(Number(message.id));
        clearTimeout(p.timer);
        if (message.ok === true) p.resolve(message.result);
        else
          p.reject(
            new AppError(
              Number(message.status) || 500,
              String(message.message ?? "檢查執行失敗").slice(0, 300),
            ),
          );
      }
    });
    this.docker.modem.demuxStream(env.stream, out, err);
    const lost = () => {
      env.broken = true;
      env.ready?.reject(new AppError(503, "檢查環境已停止"));
      for (const p of env.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError(503, "檢查環境已停止，下次執行會重新建立"));
      }
      env.pending.clear();
    };
    env.stream.once("end", lost);
    env.stream.once("close", lost);
    env.stream.once("error", lost);
  }

  private send(env: Environment, payload: Record<string, unknown>) {
    if (env.broken) return Promise.reject(new AppError(503, "檢查環境已停止"));
    const id = env.nextId++;
    return new Promise((resolve, reject) => {
      env.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          env.pending.delete(id);
          env.broken = true;
          reject(new AppError(504, "檢查執行逾時"));
        }, requestTimeoutMs),
      });
      env.stream.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }
}
