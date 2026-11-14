import { createHash } from "node:crypto";
import { AppError } from "./policy.js";
import type { Containers } from "./containers.js";
import { validateDomains } from "../shared/install-plan.js";

/**
 * 把看板「系統」頁設定的下載來源白名單寫進本實例的 egress（Squid）並重新載入。
 *
 * 只由主機執行器呼叫；找容器時核對 Compose 專案與服務名稱，驗收實例還要核對 instance 標籤，
 * 不會改到其他實例的代理。白名單在執行器再驗證一次，不信任呼叫端。
 */
const DOMAINS_FILE = "/etc/squid/allowed-domains.txt";
const applied = new Map<string, string>();

export interface EgressResult {
  ok: true;
  container: string;
  changed: boolean;
  domains: string[];
}

async function egressContainer(c: Containers) {
  const project = c.instance === "production" ? "line-agentflow" : c.instance;
  const found = await c.docker.listContainers({
    filters: JSON.stringify({
      label: [
        `com.docker.compose.project=${project}`,
        "com.docker.compose.service=egress",
      ],
      status: ["running"],
    }),
  });
  const owned = found.filter(
    (f) =>
      c.instance === "production" ||
      f.Labels?.["io.agentflow.instance"] === c.instance,
  );
  if (owned.length !== 1)
    throw new AppError(
      503,
      owned.length
        ? "找到多個套件出口代理（egress），無法判斷要更新哪一個"
        : "找不到執行中的套件出口代理（egress），請確認服務已啟動",
    );
  return owned[0].Id;
}

async function exec(c: Containers, id: string, cmd: string[]) {
  const e = await c.docker.getContainer(id).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: "root",
  });
  const stream = await e.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppError(504, "更新套件出口代理逾時")),
      20000,
    );
    stream.on("data", (b: Buffer) => chunks.push(b));
    stream.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const info = await e.inspect();
  return { exitCode: info.ExitCode ?? 1, output: Buffer.concat(chunks) };
}

export async function applyEgress(
  c: Containers,
  list: readonly string[],
): Promise<EgressResult> {
  const { domains, errors } = validateDomains(list);
  if (errors.length) throw new AppError(400, `白名單無效：${errors[0]}`);
  const id = await egressContainer(c);
  const hash = createHash("sha256").update(domains.join("\n")).digest("hex");
  if (applied.get(id) === hash)
    return { ok: true, container: id, changed: false, domains };
  // 清單為空時放一個不存在的網域，Squid 才能載入（等於全部拒絕）。
  const lines = domains.length ? domains : [".agentflow.invalid"];
  const { exitCode } = await exec(c, id, [
    "sh",
    "-ec",
    // 網域以位置參數傳入，不經過 shell 解析。
    `grep -q 'allowed-domains.txt' /etc/squid/squid.conf || exit 3
cp ${DOMAINS_FILE} ${DOMAINS_FILE}.bak
printf '%s\\n' "$@" > ${DOMAINS_FILE}.new
mv ${DOMAINS_FILE}.new ${DOMAINS_FILE}
squid -k parse -f /etc/squid/squid.conf >/dev/null 2>&1 || { mv ${DOMAINS_FILE}.bak ${DOMAINS_FILE}; exit 4; }
# squid 在容器內是 PID 1，squid -k reconfigure 會拒絕；直接送 SIGHUP 重新載入。
kill -HUP "$(cat /tmp/squid.pid)"
sleep 1`,
    "sh",
    ...lines,
  ]);
  if (exitCode === 3)
    throw new AppError(
      409,
      "套件出口代理（egress）還是舊版，不支援可設定的白名單；請在部署目錄執行 npm run deploy 重建",
    );
  if (exitCode !== 0)
    throw new AppError(502, `套件出口代理重新載入白名單失敗（${exitCode}）`);
  applied.set(id, hash);
  return { ok: true, container: id, changed: true, domains };
}
