import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RunView } from "../../shared/observation.js";
import type { ContextEvidence } from "../../shared/context-evidence.js";
import {
  Ban,
  CircleHelp,
  CircleSlash,
  Clock,
  GitMerge,
  GitPullRequest,
  Hourglass,
  Loader2,
  MessageSquareText,
  ScanSearch,
  XCircle,
} from "lucide-react";
import type {
  Action,
  Group,
  Knowledge,
  Memory,
  Project,
  Settings,
  Task,
} from "../../shared/types.js";
import { statusLabels } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type View =
  | "inbox"
  | "tasks"
  | "chat"
  | "groups"
  | "projects"
  | "system"
  | "checks"
  | "members"
  | "settings";
export type Health = {
  name: string;
  ok: boolean;
  detail: string;
  checked_at: string;
};
export type Audit = {
  id: number;
  task_id: string | null;
  kind: string;
  detail: string;
  created_at: string;
  /** 看板動態才有：這筆紀錄所屬任務的名稱。 */
  task_title?: string | null;
};
export type State = {
  settings: Settings;
  rag: {
    active: boolean;
    completed_at: string | null;
    counts: Record<string, number>;
  };
  projects: Project[];
  groups: Group[];
  tasks: Task[];
  memories: Memory[];
  knowledge: Knowledge[];
  usage: { spent: number; reserved: number; day: string; runs_today: number };
  health: Health[];
  activity: Audit[];
  alerts?: import("./alerts").Alert[];
  alertsSeenAt?: string | null;
  /** 資料庫裡的總筆數；清單只載入最近的一部分，差額用「載入更多」補上。 */
  totals?: { tasks: number; activity: number };
  /** 重試三次仍送不出去的 LINE 通知數。 */
  failedNotifications?: number;
  integrations: {
    line: boolean;
    openai: boolean;
    github: boolean;
    publicUrl: string;
  };
  webhooks: { line: string; github: string };
};
export type Detail = {
  projectReview?: {
    binding_version: number;
    config_version: number | null;
    project_name: string | null;
    repo: string | null;
    base_branch: string | null;
    group_name: string;
    confirmed: boolean;
    confirmation:
      import("../../shared/project-routing").ProjectConfirmation | null;
  };
  reportImages?: import("../../shared/query-report").ReportImage[];
  task: Task;
  contextEvidence: ContextEvidence[];
  images: {
    id: string;
    mime: string;
    sha256: string;
    origin: "direct" | "rag";
    valid: boolean;
    reason: string;
    observation: {
      summary: string;
      text: string;
      uncertainties: string[];
    } | null;
  }[];
  sources: {
    id: string;
    type: string;
    text: string | null;
    sender: string | null;
    received_at: string;
    revoked: boolean;
    has_image: boolean;
  }[];
  history: Audit[];
  references: {
    id: string;
    created_at: string;
    messages: string[];
    tasks: { id: string; title: string }[];
  }[];
  runs: RunView[];
  /** 對話串：這一題之前的各題（由舊到新）與之後的追問。 */
  thread?: {
    before: ThreadItem[];
    after: ThreadItem[];
  };
};
export type ThreadItem = {
  id: string;
  title: string;
  mode: string;
  status: Task["status"];
  created_at: string;
};
export type Account = {
  plan: string | null;
  allowed: boolean | null;
  limits: Array<{
    id: string;
    name: string | null;
    reached: string | null;
    windows: Array<{
      usedPercent: number;
      minutes: number | null;
      resetsAt: string | null;
    }>;
  }>;
  models: Array<{
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
    efforts: string[];
    defaultEffort: string;
  }>;
  checkedAt: string;
};
export type Request = <T>(
  url: string,
  method?: string,
  body?: unknown,
) => Promise<T>;
export type Run = (
  fn: () => Promise<unknown>,
  message?: string,
) => Promise<void>;
export type Act = (t: Task, a: Action, b?: object, done?: string) => unknown;

export const attention = ["awaiting_approval", "failed", "budget_wait"];
export const moving = ["queued", "running", "reviewing"];
export const date = (v: string) =>
  new Date(v).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
// 一律無條件捨去：90 分鐘是「1 小時前」，不會提早變成 2 小時。
export const ago = (v: string) => {
  const m = Math.floor((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小時前`;
  return date(v);
};
export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
};
// 連續重複的同一筆紀錄（例如同一個錯誤重試多次）合併成一筆並標次數。
export function collapseRepeats<T extends Audit>(rows: T[]) {
  const out: (T & { times: number })[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (
      last &&
      last.task_id === r.task_id &&
      last.kind === r.kind &&
      last.detail === r.detail
    )
      last.times++;
    else out.push({ ...r, times: 1 });
  }
  return out;
}
export const cash = (n: number) => `$${Number(n).toFixed(2)}`;
export const message = (e: unknown) => String(e).replace(/^Error: /, "");
export const projectName = (state: State, t: Task) =>
  state.projects.find((p) => p.id === t.project_id)?.name ?? "未指定專案";
export const groupName = (state: State, t: Task) =>
  state.groups.find((g) => g.id === t.group_id)?.name ?? "群組";

const statusVariant: Record<
  Task["status"],
  "warn" | "info" | "good" | "danger" | "secondary"
> = {
  awaiting_approval: "warn",
  budget_wait: "warn",
  queued: "info",
  running: "info",
  reviewing: "info",
  ready: "good",
  merged: "good",
  answered: "good",
  failed: "danger",
  rejected: "secondary",
  cancelled: "secondary",
  closed: "secondary",
};
export function StatusBadge({ status }: { status: Task["status"] }) {
  return <Badge variant={statusVariant[status]}>{statusLabels[status]}</Badge>;
}

export function Empty({
  title,
  children,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  if (compact)
    return (
      <div className="px-5 py-4 text-sm">
        <p className="text-muted-foreground">{title}</p>
        {children && (
          <p className="mt-0.5 text-xs text-muted-foreground/80">{children}</p>
        )}
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && (
        <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

const statusTone: Record<Task["status"], string> = {
  awaiting_approval: "text-warn",
  budget_wait: "text-warn",
  queued: "text-muted-foreground",
  running: "text-info",
  reviewing: "text-info",
  ready: "text-good",
  merged: "text-good",
  answered: "text-good",
  failed: "text-danger",
  rejected: "text-muted-foreground",
  cancelled: "text-muted-foreground",
  closed: "text-muted-foreground",
};
const statusIcon: Record<Task["status"], typeof Clock> = {
  awaiting_approval: CircleHelp,
  budget_wait: Hourglass,
  queued: Clock,
  running: Loader2,
  reviewing: ScanSearch,
  ready: GitPullRequest,
  merged: GitMerge,
  answered: MessageSquareText,
  failed: XCircle,
  rejected: Ban,
  cancelled: Ban,
  closed: CircleSlash,
};
// 列表左側的狀態圖示，讓使用者不必讀文字就能掃出卡住的工作。
export function StatusIcon({
  status,
  small,
}: {
  status: Task["status"];
  small?: boolean;
}) {
  const Icon = statusIcon[status];
  return (
    <Icon
      aria-hidden
      className={cn(
        "shrink-0",
        small ? "size-3.5" : "size-4",
        statusTone[status],
        status === "running" && "animate-spin [animation-duration:2.5s]",
      )}
    />
  );
}

// 以名稱縮寫產生頭像，不向外部載入圖片。
export function Initials({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const text = name.trim();
  const short = /^[\x00-\x7f]/.test(text)
    ? text.slice(0, 2).toUpperCase()
    : text.slice(0, 1);
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {short || "?"}
    </span>
  );
}

// 統計格：放在同一個外框裡，由呼叫端排成一列。只有需要注意的數字上色。
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "warn" | "info" | "good";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1 bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:relative focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </span>
      {hint && (
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      )}
    </button>
  );
}

const steps = ["整理需求", "審核", "排程", "開發", "驗證", "待合併"];
const stepOf: Partial<Record<Task["status"], number>> = {
  awaiting_approval: 1,
  budget_wait: 2,
  queued: 2,
  running: 3,
  reviewing: 4,
  ready: 5,
  merged: 6,
  answered: 6,
};
export function Stepper({
  status,
  query,
}: {
  status: Task["status"];
  /** 查詢任務沒有開發與合併，改顯示調查與回覆。 */
  query?: boolean;
}) {
  const at = stepOf[status];
  const labels = query
    ? ["整理需求", "審核", "排程", "調查", "整理報告", "已回覆"]
    : steps;
  if (at === undefined) return null;
  return (
    <ol className="mt-2 flex gap-1" aria-label="任務進度">
      {labels.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 flex-col gap-1" title={s}>
          <span
            className={cn(
              "h-1 rounded-full bg-border",
              i < at && "bg-primary",
              i === at && "bg-info",
            )}
          />
          <small
            className={cn(
              "hidden truncate text-[11px] text-muted-foreground sm:block",
              i === at && "font-medium text-info",
            )}
          >
            {s}
          </small>
        </li>
      ))}
    </ol>
  );
}

export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-base font-semibold">{children}</h2>
      {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

const linkLabel = (url: string) => {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)\/?$/,
  );
  return m ? `${m[1]} ${m[2] === "pull" ? "PR" : "Issue"} #${m[3]}` : url;
};
// 把文字裡的網址變成可點的連結；GitHub 的 PR、Issue 網址縮成好讀的名稱。
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s，。；、）)」]+)/g).map((part, i) =>
        i % 2 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={(e) => e.stopPropagation()}
          >
            {linkLabel(part)}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

// 長內容先收成幾行，超過才出現「展開」；短內容不多一顆按鈕。
export function Clamped({ text, lines = 4 }: { text: string; lines?: 2 | 4 }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <>
      <span
        ref={ref}
        className={cn(
          "whitespace-pre-wrap [overflow-wrap:anywhere]",
          !open && (lines === 2 ? "line-clamp-2" : "line-clamp-4"),
        )}
      >
        <Linkified text={text} />
      </span>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          className="self-start text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收合" : "展開全文"}
        </button>
      )}
    </>
  );
}

// 把頁面上的篩選寫進網址（值等於預設就拿掉），重新整理或分享連結時回到同一個畫面。
// 用 replace，不讓每次切換篩選都多一筆上一頁。
export function writeQuery(
  entries: [key: string, value: string, fallback: string][],
) {
  const q = new URLSearchParams(location.search);
  for (const [key, value, fallback] of entries)
    if (value === fallback) q.delete(key);
    else q.set(key, value);
  const qs = q.toString();
  const url = location.pathname + (qs ? `?${qs}` : "");
  if (url !== location.pathname + location.search)
    history.replaceState(null, "", url);
}

/** 清單只載入最近幾筆時顯示；按了才向伺服器多要，載入中鎖住避免連按。 */
export function LoadMore({
  shown,
  total,
  unit,
  more,
}: {
  shown: number;
  total?: number;
  unit: string;
  more: () => unknown;
}) {
  const [loading, setLoading] = useState(false);
  if (!total || total <= shown) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-sm text-muted-foreground">
      <span>
        目前載入最近 {shown} {unit}，共 {total} {unit}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void Promise.resolve(more()).finally(() => setLoading(false));
        }}
      >
        {loading && <Loader2 className="animate-spin" />}
        載入更多
      </Button>
    </div>
  );
}
