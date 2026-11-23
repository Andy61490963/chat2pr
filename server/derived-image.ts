import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { maskCredentials } from "../shared/credentials.js";
import { AppError } from "./policy.js";
import { ContainerDeadline, type Containers } from "./containers.js";
import { dockerDiskInventory } from "./docker-cleanup.js";
import { protectedTags } from "../shared/docker-disk.js";
import { installPrerequisites, planHash } from "./install-review.js";
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
const derivedInstanceLabel = "io.agentflow.derived-instance";
const projectLabel = "io.agentflow.project";
const packagesLabel = "io.agentflow.derived-packages";
const baseLabel = "io.agentflow.base";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function derivedRepository(instance: string) {
  return instance === "production"
    ? "line-agentflow-derived"
    : `agentflow-${instance}-derived`;
}
/** 以專案、分支、要安裝的套件與基底映像為鍵；任一項改變就建立新的衍生映像。 */
export function derivedKey(
  instance: string,
  projectId: string,
  branch: string,
  packages: string,
  baseId: string,
) {
  return sha256(
    JSON.stringify([
      "derived-v2",
      instance,
      projectId,
      branch,
      packages,
      baseId,
    ]),
  ).slice(0, 32);
}

/**
 * 衍生映像的套件識別：只看名稱、來源與版本，不看安裝指令的寫法。
 * 每次重新驗證 AI 都會重寫一次安裝計畫，指令的措辭（curl 參數、先後順序）幾乎每次不同；
 * 以整份指令為鍵時，同一組套件會一直重建新映像。
 * 建置失敗不會留下映像，所以只有真正裝好的才會被重用。
 */
export function packageIdentity(items: readonly InstallItem[]) {
  return sha256(
    JSON.stringify(
      canonicalItems(items)
        .map((i) => [i.name.toLowerCase(), i.source, i.version])
        .sort((a, b) => a.join("\0").localeCompare(b.join("\0"))),
    ),
  );
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
  // 計畫常用 curl 取簽章金鑰、gpg --dearmor 轉檔，工作映像沒有這兩個工具；由系統先從 Debian 官方來源補齊，
  // 不交給計畫自己裝（審查員曾因前置套件未分項而拒絕整項）。只在指令用到時補，已經有就不動；
  // 補裝失敗不中止，讓錯誤出現在真正需要它的那一項，看板才指得出是哪個套件。
  if (items.some((i) => i.commands.some((c) => /\b(?:curl|gpg)\b/.test(c))))
    lines.push(
      "if command -v apt-get >/dev/null 2>&1 && ! { command -v curl >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1; }; then",
      "  echo 'AGENTFLOW_INSTALL 準備安裝工具' >&2",
      `  { apt-get update && apt-get install -y --no-install-recommends ${installPrerequisites.join(" ")}; } || echo 'AGENTFLOW_INSTALL 安裝工具準備失敗，繼續執行計畫' >&2`,
      "fi",
    );
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
  cleanup?: {
    removed: number;
    estimatedBytes: number;
    issues: string[];
  };
}

const building = new Map<string, Promise<DerivedResult>>();

/** 建好新映像後才清理，並把用量與失敗原因交回應用程式寫稽核。 */
async function cleanupSuperseded(
  c: Containers,
  request: DerivedRequest,
  target: { baseId: string; packages: string },
  buildDeadline: ContainerDeadline,
): Promise<DerivedResult["cleanup"]> {
  const result = { removed: 0, estimatedBytes: 0, issues: [] as string[] };
  let deadline: ContainerDeadline | undefined;
  let failed = false;
  try {
    deadline = new ContainerDeadline(
      Math.min(5000, buildDeadline.remaining()),
      new AppError(408, "衍生映像清理逾時"),
    );
    const inventory = await deadline.run(() =>
      dockerDiskInventory(c.docker, c.instance),
    );
    const used = new Set(
      inventory.containers.map((container) => container.imageId),
    );
    const candidates = inventory.images.filter(
      ({ id, labels, tags, containers }) =>
        labels[DERIVED_LABEL] === "v1" &&
        labels[derivedInstanceLabel] === c.instance &&
        labels[projectLabel] === request.projectId &&
        labels[packagesLabel] === target.packages &&
        !!labels[baseLabel] &&
        labels[baseLabel] !== target.baseId &&
        id !== target.baseId &&
        containers <= 0 &&
        !used.has(id) &&
        !tags.some((tag) =>
          protectedTags.has(tag.slice(tag.lastIndexOf(":") + 1)),
        ),
    );
    if (!candidates.length) return undefined;
    // 部署可能在安裝期間換過基底標籤，舊基底的建置不能清掉新基底的成果。
    if ((await deadline.run(() => c.ready(request.base))) !== target.baseId)
      return undefined;
    for (const image of candidates) {
      buildDeadline.check();
      // 依映像 ID 刪除，避免標籤移到別的映像。讓 Docker 再檢查容器引用，並保留父映像。
      const changes: Docker.ImageRemoveInfo[] = await deadline.run(() =>
        c.docker
          .getImage(image.id)
          .remove({ noprune: true })
          .catch(() => []),
      );
      if (!changes.some(({ Deleted }) => Deleted === image.id)) {
        failed = true;
        continue;
      }
      result.removed++;
      // Docker 的共用層可能仍被其他映像使用，只估算這個映像獨有的大小。
      if (image.sharedSize >= 0)
        result.estimatedBytes += Math.max(0, image.size - image.sharedSize);
    }
  } catch {
    result.issues.push(
      "舊衍生映像清理未完成，執行器未能確認映像狀態或刪除結果。可在系統頁的磁碟管理查看剩餘映像。",
    );
  } finally {
    deadline?.close();
  }
  if (failed)
    result.issues.push(
      "部分舊衍生映像未能清除，Docker 未回報映像已刪除。可在系統頁的磁碟管理查看剩餘映像。",
    );
  return result.removed || result.issues.length ? result : undefined;
}

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
    labels[derivedInstanceLabel] !== c.instance ||
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
  const packages = packageIdentity(request.items);
  const key = derivedKey(
    c.instance,
    request.projectId,
    request.branch,
    packages,
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
  if (pending) {
    const result = await pending;
    // 只有實際發起建置的請求會寫清理稽核。
    return { ...result, cleanup: undefined };
  }
  const job = build(c, request, { baseId, plan, key, tag, packages }).finally(
    () => building.delete(tag),
  );
  building.set(tag, job);
  return job;
}

async function build(
  c: Containers,
  request: DerivedRequest,
  target: {
    baseId: string;
    plan: string;
    key: string;
    tag: string;
    packages: string;
  },
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
    // 先遮蔽再截斷：截斷點落在帳密中間時，剩下的半段遮蔽規則認不出來。
    const output =
      `${maskCredentials(stdout).slice(-6000)}\n${maskCredentials(stderr).slice(-6000)}`.trim();
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
        comment: "專案衍生映像",
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
            [derivedInstanceLabel]: c.instance,
            [DERIVED_LABEL]: "v1",
            "io.agentflow.derived-key": target.key,
            [projectLabel]: request.projectId,
            "io.agentflow.plan": target.plan,
            [baseLabel]: target.baseId,
            [packagesLabel]: target.packages,
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
    const cleanup = await cleanupSuperseded(c, request, target, deadline);
    return {
      image: target.tag,
      reused: false,
      planHash: target.plan,
      exitCode: 0,
      output,
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    deadline.close();
    if (owned) await c.finishContainer(owned.id, request.runId, failure);
  }
}
