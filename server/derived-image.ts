import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { AppError } from "./policy.js";
import type { Containers } from "./containers.js";
import { planHash } from "./install-review.js";
import {
  MAX_INSTALL_ITEMS,
  canonicalItems,
  ruleCheck,
  validateDomains,
  type InstallItem,
} from "../shared/install-plan.js";

/**
 * 專案衍生映像：把安裝前審查放行的系統套件，在獨立的 root 安裝階段裝進工作映像的副本。
 *
 * 安裝階段：容器內 root、根目錄可寫，只補回安裝必要的 capabilities；仍然沒有工作目錄、
 * 主機目錄、Docker socket 或機密，網路只經 egress 白名單代理。
 * 之後的安裝、測試、開發、審查照常以非 root、唯讀根目錄使用這個映像（見 containers.phase）。
 */
export const INSTALL_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETUID",
  "SETGID",
];
export const DERIVED_LABEL = "io.agentflow.derived";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function derivedRepository(instance: string) {
  return instance === "production"
    ? "line-agentflow-derived"
    : `agentflow-${instance}-derived`;
}
/** 以專案、分支、安裝計畫與基底映像為鍵；任一項改變就建立新的衍生映像。 */
export function derivedKey(
  instance: string,
  projectId: string,
  branch: string,
  plan: string,
  baseId: string,
) {
  return sha256(
    JSON.stringify(["derived-v1", instance, projectId, branch, plan, baseId]),
  ).slice(0, 32);
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** root 安裝階段的指令稿；代理只放在指令稿內，不會寫進衍生映像的設定。 */
export function installScript(items: readonly InstallItem[], proxy: string) {
  const lines = [
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    `export HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} http_proxy=${proxy} https_proxy=${proxy} NO_PROXY= no_proxy=`,
    // egress 只放行 TLS；Debian 預設的 http 套件來源改成 https，並讓 apt 使用代理。
    "if [ -d /etc/apt ]; then",
    "  mkdir -p /etc/apt/apt.conf.d",
    `  printf 'Acquire::http::Proxy "%s";\\nAcquire::https::Proxy "%s";\\n' "$HTTPS_PROXY" "$HTTPS_PROXY" > /etc/apt/apt.conf.d/99agentflow-proxy`,
    "  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do",
    `    if [ -f "$f" ]; then sed -i 's#http://#https://#g' "$f"; fi`,
    "  done",
    "fi",
  ];
  for (const item of canonicalItems(items)) {
    lines.push(
      `echo ${quote(`AGENTFLOW_INSTALL 安裝 ${item.name}${item.version ? ` ${item.version}` : ""}`)} >&2`,
      "(",
      "set -eu",
      ...item.commands,
      ")",
    );
  }
  lines.push(
    "rm -f /etc/apt/apt.conf.d/99agentflow-proxy",
    "rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /root/.npm /root/.cache 2>/dev/null || true",
    "echo 'AGENTFLOW_INSTALL 完成' >&2",
  );
  return lines.join("\n");
}

/** Docker 未使用 TTY 時的多工輸出：8 位元組標頭（類型、長度）加內容。 */
function demux(raw: Buffer) {
  let stdout = "",
    stderr = "",
    offset = 0;
  while (offset + 8 <= raw.length) {
    const type = raw[offset],
      size = raw.readUInt32BE(offset + 4);
    const chunk = raw.subarray(offset + 8, offset + 8 + size).toString("utf8");
    if (type === 2) stderr += chunk;
    else stdout += chunk;
    offset += 8 + size;
  }
  return { stdout, stderr };
}

export interface DerivedRequest {
  runId: string;
  /** 基底工作映像（預設工作映像、SQL Server 映像或專案自訂映像）。 */
  base: string;
  projectId: string;
  branch: string;
  /** 已通過安裝前審查的項目。 */
  items: InstallItem[];
  /** 目前的下載來源白名單；執行器再用固定規則核對一次。 */
  domains: string[];
  timeoutMs: number;
}
export interface DerivedResult {
  image: string | null;
  reused: boolean;
  planHash: string;
  exitCode: number;
  output: string;
}

const building = new Map<string, Promise<DerivedResult>>();

/** 已存在而且標籤對得上的衍生映像才重用；其他同名映像一律不碰。 */
async function existing(c: Containers, tag: string, key: string) {
  const info = await c.docker
    .getImage(tag)
    .inspect()
    .catch((e: { statusCode?: number }) => {
      if (e.statusCode === 404) return undefined;
      throw e;
    });
  if (!info) return undefined;
  const labels = info.Config?.Labels ?? {};
  if (
    labels[DERIVED_LABEL] !== "v1" ||
    labels["io.agentflow.derived-instance"] !== c.instance ||
    labels["io.agentflow.derived-key"] !== key
  )
    throw new AppError(409, `衍生映像 ${tag} 不屬於此執行環境`);
  return info;
}

export async function derivedImage(
  c: Containers,
  request: DerivedRequest,
): Promise<DerivedResult> {
  if (!request.items.length) throw new AppError(400, "沒有要安裝的項目");
  if (request.items.length > MAX_INSTALL_ITEMS)
    throw new AppError(400, `安裝項目最多 ${MAX_INSTALL_ITEMS} 個`);
  const { domains, errors } = validateDomains(request.domains);
  if (errors.length)
    throw new AppError(400, `下載來源白名單無效：${errors[0]}`);
  // 執行器再核對一次固定規則；應用程式送來的計畫也不能繞過。
  for (const item of request.items) {
    const reason = ruleCheck(item, domains);
    if (reason)
      throw new AppError(
        400,
        `安裝項目 ${item.name} 未通過固定規則：${reason}`,
      );
  }
  const baseId = await c.ready(request.base);
  const plan = planHash(request.items);
  const key = derivedKey(
    c.instance,
    request.projectId,
    request.branch,
    plan,
    baseId,
  );
  const tag = `${derivedRepository(c.instance)}:${key}`;
  const found = await existing(c, tag, key);
  if (found) {
    await c.ready(tag);
    return {
      image: tag,
      reused: true,
      planHash: plan,
      exitCode: 0,
      output: "",
    };
  }
  // 同一個衍生映像同時被兩個任務要求時，只建一次。
  const pending = building.get(tag);
  if (pending) return pending;
  const job = build(c, request, { baseId, plan, key, tag }).finally(() =>
    building.delete(tag),
  );
  building.set(tag, job);
  return job;
}

async function build(
  c: Containers,
  request: DerivedRequest,
  target: { baseId: string; plan: string; key: string; tag: string },
): Promise<DerivedResult> {
  const deadline = c.begin(
    request.runId,
    Math.max(1000, request.timeoutMs),
    new AppError(408, "系統套件安裝超過時間限制"),
  );
  let owned: Docker.Container | undefined, failure: unknown;
  try {
    const base = await deadline.run(() =>
      c.docker.getImage(target.baseId).inspect(),
    );
    const network = c.network("line-agentflow_install");
    await deadline.run(() => c.assertNetwork(network));
    const container = await c.createOwnedContainer(
      request.runId,
      {
        Image: target.baseId,
        User: "0:0",
        WorkingDir: "/",
        Entrypoint: [
          "sh",
          "-c",
          installScript(request.items, "http://egress:3128"),
        ],
        Cmd: [],
        Labels: c.labels(request.runId),
        HostConfig: {
          // 沒有工作目錄、主機目錄、Docker socket 或其他掛載；只補回安裝必要的權限。
          Binds: [],
          ReadonlyRootfs: false,
          CapDrop: ["ALL"],
          CapAdd: INSTALL_CAPABILITIES,
          SecurityOpt: ["no-new-privileges:true"],
          Privileged: false,
          Memory: 2 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          PidsLimit: 512,
          NetworkMode: network,
          Tmpfs: { "/tmp": "rw,nosuid,size=512m,mode=1777" },
          AutoRemove: false,
        },
      },
      deadline,
    );
    owned = container;
    await deadline.run(() => container.start());
    const result = await deadline.run(() => container.wait());
    const raw = (await deadline.run(() =>
      container.logs({ stdout: true, stderr: true, follow: false }),
    )) as unknown as Buffer;
    const { stdout, stderr } = demux(Buffer.from(raw));
    const output = `${stdout.slice(-6000)}\n${stderr.slice(-6000)}`.trim();
    if (result.StatusCode !== 0)
      return {
        image: null,
        reused: false,
        planHash: target.plan,
        exitCode: result.StatusCode,
        output,
      };
    const config = base.Config ?? ({} as Docker.ImageInspectInfo["Config"]);
    const at = target.tag.lastIndexOf(":");
    // 衍生映像沿用基底的使用者、環境變數與進入點；安裝用的指令稿與代理不寫進映像。
    await deadline.run(() =>
      container.commit({
        repo: target.tag.slice(0, at),
        tag: target.tag.slice(at + 1),
        comment: "agentflow derived image",
        _body: {
          User: config.User || "1000:1000",
          Env: config.Env ?? [],
          Entrypoint: config.Entrypoint?.length
            ? config.Entrypoint
            : ["docker-entrypoint.sh"],
          Cmd: config.Cmd?.length ? config.Cmd : ["node"],
          WorkingDir: config.WorkingDir || "/workspace",
          Labels: {
            ...(config.Labels ?? {}),
            // 建置容器的歸屬標籤（run、managed、instance）不帶進映像，否則從映像建立的容器
            // 會繼承它們而被誤認成工作容器；映像改用 derived-instance 等專屬標籤歸屬到專案與實例。
            "io.agentflow.run": "",
            "io.agentflow.managed": "",
            "io.agentflow.instance": "",
            "io.agentflow.derived-instance": c.instance,
            [DERIVED_LABEL]: "v1",
            "io.agentflow.derived-key": target.key,
            "io.agentflow.project": request.projectId,
            "io.agentflow.plan": target.plan,
            "io.agentflow.base": target.baseId,
          },
        },
      }),
    );
    // 確認衍生映像的設定沒有混入安裝指令稿或代理，否則刪掉不用。
    const made = await c.docker.getImage(target.tag).inspect();
    const leaked =
      JSON.stringify(made.Config?.Entrypoint ?? []).includes(
        "AGENTFLOW_INSTALL",
      ) ||
      (made.Config?.Env ?? []).some((e) => /^https?_proxy=/i.test(e)) ||
      made.Config?.User !== (config.User || "1000:1000");
    if (leaked) {
      await c.docker
        .getImage(target.tag)
        .remove()
        .catch(() => {});
      throw new AppError(500, "衍生映像設定異常，已刪除，請回報");
    }
    await c.ready(target.tag);
    return {
      image: target.tag,
      reused: false,
      planHash: target.plan,
      exitCode: 0,
      output,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    deadline.close();
    if (owned) await c.finishContainer(owned.id, request.runId, failure);
  }
}
