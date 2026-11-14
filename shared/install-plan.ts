/**
 * 安裝階段的下載來源白名單與安裝計畫的固定規則（看板、應用程式與主機執行器共用的純函式）。
 *
 * 安全原則：工作容器只能經 egress 代理以 TLS 連到白名單網域；安裝計畫由獨立審查判斷，
 * 先跑這裡的固定規則，再由審查模型判斷用途。執行器在建立衍生映像前會用同一套規則再核對一次。
 */

/** 預設的下載來源：套件庫、Debian／Ubuntu 套件庫、Microsoft 套件庫與 GitHub Releases。 */
export const DEFAULT_EGRESS_DOMAINS = [
  ".registry.npmjs.org",
  ".registry.yarnpkg.com",
  ".pypi.org",
  ".pythonhosted.org",
  ".nuget.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "packages.microsoft.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];
export const MAX_EGRESS_DOMAINS = 100;

/** 主機、內網與保留網域；即使管理者填入也不放行。 */
const reservedSuffix =
  /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp|test|example|invalid)$/;

/**
 * 正規化一個白名單網域。開頭的點代表連同子網域（與 Squid dstdomain 相同）。
 * 不接受 IP、萬用字元、網址、埠號、單一層網域與內網保留名稱。
 */
export function normalizeDomain(raw: string): string | { error: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { error: "空白" };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value) || value.includes("/"))
    return { error: `${value}：請只填網域，不要填網址或路徑` };
  if (value.includes("*"))
    return { error: `${value}：不支援萬用字元；開頭加點代表連同子網域` };
  if (value.includes(":")) return { error: `${value}：不可指定埠號或 IPv6` };
  const host = value.startsWith(".") ? value.slice(1) : value;
  if (host.length > 253) return { error: `${value}：網域過長` };
  if (/^[\d.]+$/.test(host)) return { error: `${value}：不可填 IP 位址` };
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ||
    !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(labels[labels.length - 1])
  )
    return { error: `${value}：不是有效的網域` };
  if (reservedSuffix.test(host))
    return { error: `${value}：主機或內網名稱不可加入白名單` };
  return value;
}

/** 驗證整份白名單；重複或已被「.網域」涵蓋的項目會合併。 */
export function validateDomains(list: readonly string[]): {
  domains: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const set = new Set<string>();
  for (const raw of list) {
    const d = normalizeDomain(raw);
    if (typeof d === "string") set.add(d);
    else if (d.error !== "空白") errors.push(d.error);
  }
  // Squid 對同時列出 example.com 與 .example.com 會警告，只保留涵蓋範圍較大的一筆。
  const domains = [...set]
    .filter(
      (d) =>
        !(
          (!d.startsWith(".") && set.has(`.${d}`)) ||
          [...set].some(
            (o) => o !== d && o.startsWith(".") && d.endsWith(o) && d !== o,
          )
        ),
    )
    .sort((a, b) => a.replace(/^\./, "").localeCompare(b.replace(/^\./, "")));
  if (domains.length > MAX_EGRESS_DOMAINS)
    errors.push(`最多 ${MAX_EGRESS_DOMAINS} 個網域`);
  return { domains, errors };
}

/** 看板「系統」頁的下載來源白名單。 */
export interface EgressSettings {
  domains: string[];
  defaults: string[];
  /** 管理者改過；false 代表使用預設值（之後預設增加的來源會自動生效）。 */
  custom: boolean;
  max: number;
}

/** 設定值缺少時使用預設白名單；壞掉的值不放行任何東西。 */
export function egressDomains(settings: { egress_domains?: unknown }) {
  const saved = settings.egress_domains;
  if (!Array.isArray(saved)) return [...DEFAULT_EGRESS_DOMAINS];
  return validateDomains(saved.filter((d) => typeof d === "string")).domains;
}

/** 主機名稱是否在白名單內；「.example.com」同時涵蓋 example.com 與子網域。 */
export function domainAllowed(host: string, domains: readonly string[]) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) =>
    d.startsWith(".") ? h === d.slice(1) || h.endsWith(d) : h === d,
  );
}

// ---- 安裝計畫 ----

export interface InstallItem {
  /** 套件或檔案名稱。 */
  name: string;
  /** 來源網址（https）。 */
  source: string;
  /** 版本；沒有指定時為空字串。 */
  version: string;
  /** 為什麼需要。 */
  purpose: string;
  /** 以 root 在安裝階段執行的指令（每行一個 shell 命令）。 */
  commands: string[];
}

export interface InstallDecision extends InstallItem {
  approved: boolean;
  /** 放行或拒絕的原因。 */
  reason: string;
  /** rules：固定規則拒絕；model：審查模型判斷（固定規則已通過）。 */
  decidedBy: "rules" | "model";
}

/** 一次安裝前審查的結果；寫進專案設定、稽核與任務詳情。 */
export interface InstallReview {
  /** 放行項目的雜湊，衍生映像以此為鍵。 */
  planHash: string;
  /** 誰審查：固定規則＋哪個審查模型。 */
  reviewer: string;
  reviewedAt: string;
  decisions: InstallDecision[];
}

/** 任務一次執行使用的系統套件與映像；任務詳情顯示「裝了什麼、為什麼、誰放行」。 */
export interface InstallReport {
  /** 實際使用的衍生映像標籤；沒有放行項目或建置失敗時為 null。 */
  image: string | null;
  /** 衍生映像的基底（工作映像或 SQL Server 映像）。 */
  base: string;
  /** 重用既有衍生映像，沒有重新下載。 */
  reused: boolean;
  /** 建置失敗時的白話原因。 */
  error?: string;
  review: InstallReview;
}

export const MAX_INSTALL_ITEMS = 12;
export const MAX_INSTALL_COMMANDS = 20;
export const MAX_INSTALL_COMMAND_LENGTH = 1000;

/** 安裝指令允許的第一個詞；其他指令都不算「只做安裝」。 */
const installVerbs = new Set([
  "apt-get",
  "apt",
  "dpkg",
  "curl",
  "wget",
  "gpg",
  "install",
  "mkdir",
  "ln",
  "chmod",
  "tar",
  "unzip",
  "gunzip",
  "cp",
  "mv",
  "rm",
  "echo",
  "printf",
  "tee",
  "sha256sum",
  "sha512sum",
  "update-ca-certificates",
  "update-alternatives",
  "dotnet",
  "npm",
  "pip",
  "pip3",
  "python3",
  "test",
  "[",
  "true",
]);
/** 這些工具只能用來安裝（指令中要有 install）。 */
const installOnly = new Set(["dotnet", "npm", "pip", "pip3", "python3"]);

const urlPattern = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"`|;&)<>\\]+)/gi;

/** 下載後直接執行、執行腳本檔或動態產生指令。 */
const runsScript = [
  /\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|c)?sh\b/,
  /\|\s*(sudo\s+)?(python[\d.]*|node|perl|ruby|php|pwsh|powershell)\b/,
  /<\(\s*(curl|wget)\b/,
  /\$\(\s*(curl|wget)\b/,
  /`\s*(curl|wget)\b/,
  /(^|&&|\|\||[;\n])\s*(sudo\s+)?(eval|source|exec|\.|(ba|z|da|k)?sh)\s/,
];
/** 讀取機密、環境變數或系統執行資料。 */
const readsSecrets =
  /\bprintenv\b|(^|[;&|]\s*)env\s*($|[;&|])|\bexport\s+-p\b|\bdeclare\s+-x\b|\bset\s*($|[;&|])|\/proc\/|\benviron\b|\.ssh\b|id_rsa|id_ed25519|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.aws\b|\.docker\/config|\.kube\b|secrets?\.json|(^|[\s/'"])\.env\b|\/agentflow\/env|\.codex|\$\{?\w*(token|secret|password|passwd|api_?key|credential|auth)\w*\}?/i;
/** 碰到容器外的資源：主機、Docker、其他網路服務、系統服務。 */
const outsideVerbs = new Set(
  (
    "docker podman kubectl nsenter chroot mount umount ssh scp sftp rsync nc ncat socat telnet ftp " +
    "iptables ip6tables nft ip sysctl modprobe insmod rmmod systemctl service crontab tailscale wg openvpn"
  ).split(" "),
);
const outsidePaths =
  /\/var\/run|\/run\/docker|docker\.sock|host\.docker\.internal|\/dev\/(tcp|udp)\/|\/workspace\b|\/baseline\b|\/sys\/|\/dev\/(sd|nvme|mem|kmem)/i;
/** 下載工具只能下載，不能把資料送出去。 */
const uploads =
  /\b(curl|wget)\b[^;&|]*\s(-T|--upload-file|-d|--data[\w-]*|-F|--form|-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE)|--post-(data|file)|--method)(\s|=|$)/i;

function segments(command: string) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 單一指令片段的第一個詞（略過 VAR=值 與 env 前綴）。 */
function verbOf(segment: string) {
  const words = segment.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (words[i] === "env") {
    i++;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  }
  return words[i] ?? "";
}

/**
 * 固定規則：回傳拒絕原因，通過時回傳 null。
 * 放行條件是來源在白名單、指令只做安裝；用途是否合理由審查模型判斷。
 */
export function ruleCheck(
  item: InstallItem,
  domains: readonly string[],
): string | null {
  if (!/^[\w.+:@/-]{1,100}$/.test(item.name)) return "名稱只能是套件或檔案名稱";
  if (item.purpose.trim().length < 4) return "沒有說明用途";
  if (!item.commands.length) return "沒有安裝指令";
  if (item.commands.length > MAX_INSTALL_COMMANDS)
    return `指令超過 ${MAX_INSTALL_COMMANDS} 行`;
  let source: URL;
  try {
    source = new URL(item.source);
  } catch {
    return "來源不是網址";
  }
  if (source.protocol !== "https:") return "來源不是 https（非 TLS）";
  if (!domainAllowed(source.hostname, domains))
    return `來源 ${source.hostname} 不在白名單`;
  for (const command of item.commands) {
    if (command.length > MAX_INSTALL_COMMAND_LENGTH) return "單行指令過長";
    if (readsSecrets.test(command)) return "指令要求讀取機密或環境變數";
    if (runsScript.some((p) => p.test(command)))
      return "指令會下載後直接執行不明腳本或動態產生指令";
    if (outsidePaths.test(command)) return "指令會修改或連到容器外的資源";
    if (uploads.test(command)) return "指令會把資料送出容器";
    for (const match of command.matchAll(urlPattern)) {
      if (match[1].toLowerCase() !== "https")
        return `指令使用非 TLS 的網址（${match[1]}://）`;
      const host = match[2].split(/[/:?#]/)[0];
      if (!domainAllowed(host, domains)) return `網址 ${host} 不在白名單`;
    }
    for (const segment of segments(command)) {
      const verb = verbOf(segment);
      if (outsideVerbs.has(verb)) return "指令會修改或連到容器外的資源";
      if (!installVerbs.has(verb)) return `「${verb}」不是安裝指令`;
      if (installOnly.has(verb) && !/\binstall\b/.test(segment))
        return `${verb} 只能用來安裝`;
    }
  }
  return null;
}

/** 計畫的正規形式；雜湊與比對都用這個，避免欄位順序或空白造成重建。 */
export function canonicalItems(items: readonly InstallItem[]) {
  return items.map((i) => ({
    name: i.name.trim(),
    source: i.source.trim(),
    version: i.version.trim(),
    commands: i.commands.map((c) => c.trim()).filter(Boolean),
  }));
}

/** 任務詳情與稽核共用的白話摘要。 */
export function reviewSummary(review: InstallReview) {
  const approved = review.decisions.filter((d) => d.approved);
  const rejected = review.decisions.filter((d) => !d.approved);
  return [
    approved.length
      ? `放行 ${approved.map((d) => `${d.name}${d.version ? ` ${d.version}` : ""}（${d.purpose}）`).join("、")}`
      : "",
    rejected.length
      ? `拒絕 ${rejected.map((d) => `${d.name}（${d.reason}）`).join("、")}`
      : "",
  ]
    .filter(Boolean)
    .join("；");
}
