import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { phaseLabels, type RunView } from "../../shared/observation.js";
import { parseFailure } from "../../shared/failure-text.js";
import {
  type inferenceStatusLabels,
  taskCompletionEvents,
  taskEndLabels,
  taskStationLabels,
  taskStationStatusLabels,
} from "../../shared/status-glossary.js";
import {
  runProgress,
  type RunProgressInput,
} from "../../shared/run-progress.js";
import type { ContextEvidence } from "../../shared/context-evidence.js";
import type { TaskQueue } from "../../shared/capacity.js";
import { memoryHold as hostMemoryHold } from "../../shared/host-hold.js";
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
  DashboardGroup,
  Knowledge,
  Memory,
  Project,
  Settings,
  SourceMessage,
  StateTotals,
  Task,
  TaskStatus,
} from "../../shared/types.js";
import {
  countStatuses,
  endedStatuses,
  statusLabels,
  taskGroups,
} from "../../shared/types.js";
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
  inferenceStatus?: keyof typeof inferenceStatusLabels;
  quota?: { ok: boolean; detail: string; checked_at: string } | null;
  name: string;
  ok: boolean;
  detail: string;
  checked_at: string;
  outage_started_at?: string | null;
};
export const healthStatus = (row?: Health) =>
  row?.inferenceStatus ?? (row ? (row.ok ? "healthy" : "failed") : "unknown");
export const healthBadge = {
  healthy: "good",
  failed: "danger",
  unknown: "secondary",
} as const;
export type Audit = {
  id: number;
  task_id: string | null;
  kind: string;
  detail: string;
  created_at: string;
  /** 看板動態才有：這筆紀錄所屬任務的名稱。 */
  task_title?: string | null;
  task_mode?: Task["mode"] | null;
};
export type State = {
  stuckTasks?: import("../../shared/stuck-tasks.js").StuckTask[];
  stuckTasksTotal?: number;
  connectionSecrets?: import("../../shared/connection-secrets.js").ConnectionSecretStatus;
  pickLists?: import("../../shared/pick-list.js").PickList[];
  settings: Settings;
  rag: {
    active: boolean;
    completed_at: string | null;
    counts: Record<string, number>;
  };
  projects: Project[];
  groups: DashboardGroup[];
  tasks: Task[];
  memories: Memory[];
  knowledge: Knowledge[];
  usage: { spent: number; reserved: number; day: string; runs_today: number };
  health: Health[];
  diskDispatchPaused?: boolean;
  activity: Audit[];
  alerts?: import("./alerts").Alert[];
  alertsSeenAt?: string | null;
  /**
   * 資料庫裡的總筆數與各狀態數量；已結束的任務與動態只載入最近的一部分，差額用「載入更多」補上。
   * 舊版伺服器可能沒有狀態分布與合併統計。
   */
  totals?: Pick<StateTotals, "tasks" | "activity"> & Partial<StateTotals>;
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
  fullTitle?: string;
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
  sources: SourceMessage[];
  history: Audit[];
  references: {
    id: string;
    created_at: string;
    messages: string[];
    tasks: { id: string; title: string }[];
  }[];
  runs: RunView[];
  /** 排隊中為什麼還沒開始；不在排隊中或舊版伺服器沒有這個欄位時為 null／undefined。 */
  queue?: TaskQueue | null;
  /** 這個任務送到群組的訊息與送達狀態（由舊到新）；舊版伺服器沒有這個欄位。 */
  groupDeliveries?: import("../../shared/group-delivery").GroupDelivery[];
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
/**
 * 送出並顯示結果。回傳 true 代表請求成功（之後的重新整理失敗也算成功，避免使用者重送）；
 * false 代表失敗並已顯示錯誤。表單只在 true 時清空輸入，失敗時保留原字。
 */
export type Run = <T>(
  fn: () => Promise<T>,
  message?: string | ((result: T) => string),
) => Promise<boolean>;
export type Act = (
  t: Task,
  a: Action,
  b?: object,
  done?: string,
) => Promise<boolean>;

/** 主機記憶體不足而自動暫停派工的原因；沒有暫停或檢查結果已過期時為 null。 */
export const memoryHold = (state: State | null | undefined) =>
  hostMemoryHold(state?.health);

// 看板的任務分組定義在 shared/types.ts 的 taskGroups：伺服器依它完整載入未結束的任務，兩邊一起改。
// 等待額度會自動繼續，不算「需要你處理」。
export const attention: TaskStatus[] = taskGroups.attention;
export const waiting: TaskStatus[] = taskGroups.waiting;
export const moving: TaskStatus[] = taskGroups.moving;
export const ready: TaskStatus[] = taskGroups.ready;
/**
 * 一組狀態的任務數：有伺服器的 byStatus 就用它（不受清單載入範圍影響），
 * 舊版伺服器沒有時退回只算已載入的任務。
 */
export const countOf = (state: State, statuses: readonly TaskStatus[]) =>
  state.totals?.byStatus
    ? countStatuses(state.totals.byStatus, statuses)
    : state.tasks.filter((t) => statuses.includes(t.status)).length;

/** 每隔一段時間重繪一次，讓「已跑幾分」這類相對時間跟著走。 */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** 進行中執行的一行進度（階段，已跑時間，期限）；心跳逾時改說「狀態待確認」。 */
export function RunProgressLine({
  run,
  className,
}: {
  run: RunProgressInput;
  className?: string;
}) {
  const now = useNow();
  const p = runProgress(run, now);
  if (!p) return null;
  return (
    <span
      className={cn(
        "truncate text-sm tabular-nums",
        p.stale ? "text-warn" : "text-muted-foreground",
        className,
      )}
    >
      {p.text}
    </span>
  );
}
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
  "warn" | "good" | "danger" | "secondary"
> = {
  awaiting_approval: "warn",
  budget_wait: "warn",
  queued: "warn",
  running: "good",
  reviewing: "good",
  ready: "good",
  merged: "good",
  answered: "good",
  failed: "danger",
  rejected: "secondary",
  cancelled: "secondary",
  closed: "secondary",
};
export function StatusBadge({
  status,
  label = statusLabels[status],
}: {
  status: TaskStatus;
  label?: string;
}) {
  return <Badge variant={statusVariant[status]}>{label}</Badge>;
}

// 空狀態：圖示只是輔助（aria-hidden），標題說明現況，內文說明接下來會發生什麼。
export function Empty({
  icon,
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
      <div className="flex gap-3 px-5 py-4 text-sm">
        {icon && (
          <span
            aria-hidden
            className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-muted-foreground">{title}</p>
          {children && (
            <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
          )}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      {icon && (
        <span
          aria-hidden
          className="mb-2 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </span>
      )}
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
  queued: "text-warn",
  running: "text-good",
  reviewing: "text-good",
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
        "grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium text-foreground",
        className,
      )}
      aria-hidden
    >
      {short || "?"}
    </span>
  );
}

// 站別順序與軌道一致，查詢和修改任務只在後三站使用不同名稱。
const stationOf: Partial<Record<TaskStatus, number>> = {
  awaiting_approval: 1,
  budget_wait: 2,
  queued: 2,
  running: 3,
  reviewing: 4,
  ready: 5,
  merged: 5,
  answered: 5,
};
const endStationIndex = { queue: 2, work: 3, verify: 4, pr: 5 } as const;

const endDay = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  month: "numeric",
  day: "numeric",
});

function failedStation(error: Task["last_error"], query: boolean) {
  const headline = parseFailure(error)?.headline;
  if (!headline) return undefined;
  const where = headline.match(/（([^）]+)階段）：/)?.[1];
  if (
    [phaseLabels.test, phaseLabels.review, phaseLabels.verify].some(
      (label) => label === where,
    )
  )
    return 4;
  if (!query && where === phaseLabels.publish) return 5;
  if ([phaseLabels.code, phaseLabels.collect].some((label) => label === where))
    return 3;
  // 舊資料或準備環境的錯誤沒有可確認的站別。
  return undefined;
}

export function StationTrack({
  task,
  labelled = false,
  statusLabel,
  compact = false,
  endAction,
}: {
  task: Pick<
    Task,
    | "status"
    | "mode"
    | "last_error"
    | "end_summary"
    | "updated_at"
    | "pr_number"
  >;
  labelled?: boolean;
  statusLabel?: string;
  compact?: boolean;
  endAction?: ReactNode;
}) {
  const { status } = task;
  const ended = endedStatuses.includes(status);
  const end = task.end_summary;
  const endKind =
    end?.kind ??
    (status === "rejected"
      ? "reject"
      : status === "cancelled"
        ? "cancel"
        : "other");
  const endCopy = taskEndLabels[endKind];
  const completion =
    endKind === "other" && (status === "merged" || status === "answered")
      ? taskCompletionEvents[status]
      : null;
  const endAt = end?.at ?? task.updated_at;
  const query = task.mode === "query";
  const station = taskStationLabels;
  const copy = taskStationStatusLabels;
  const stations = [
    station.request,
    station.approval,
    station.queue,
    query ? station.query : station.change,
    query ? station.report : station.verify,
    (query || status === "answered") && end?.station !== "pr"
      ? station.reply
      : station.pr,
  ];
  // 無需修改的任務在開發站回覆，沒有經過驗證或開 PR。
  if (!query && status === "answered") stations.splice(4, 1);
  const endStation = end?.station ?? (ended && task.pr_number ? "pr" : null);
  const at =
    status === "failed"
      ? failedStation(task.last_error, query)
      : !query && status === "answered"
        ? stations.length - 1
        : (stationOf[status] ??
          (endStation ? endStationIndex[endStation] : undefined));
  const label =
    ended && !completion
      ? endCopy.badge
      : status === "awaiting_approval"
        ? copy.decision
        : status === "running" && query
          ? copy.runningQuery
          : status === "failed" && at === 4 && !query
            ? copy.blockedAtVerification
            : status === "ready"
              ? copy.ready
              : statusLabels[status];
  const position = at === undefined ? copy.unknownStation : stations[at];

  return (
    <span className="station-track" data-tone={statusVariant[status]}>
      <span
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          compact &&
            "[&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal",
        )}
      >
        <StatusBadge status={status} label={statusLabel ?? label} />
        {(!compact || ended) && (
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {ended ? (
              <>
                {end?.actor &&
                  // 英數字結尾的帳號和「於」之間留空格，避免黏在一起。
                  `${end.actor}${/[A-Za-z0-9]$/.test(end.actor) ? " " : ""}於 `}
                <time dateTime={endAt}>
                  {labelled ? date(endAt) : endDay.format(new Date(endAt))}
                </time>{" "}
                {completion ?? endCopy.event}
                {labelled && end?.reason && `，原因是${end.reason}`}
              </>
            ) : at === undefined ? (
              position
            ) : (
              `${position}站`
            )}
          </span>
        )}
        {ended && endAction}
      </span>
      {(!ended || at !== undefined) && (
        <span
          role="img"
          aria-label={`站別軌道，${at === undefined ? position : `${ended ? "結束前到達" : "目前在"}${position}站`}${labelled ? `，依序為${stations.join("、")}` : ""}`}
          className={cn("station-rail", labelled && "station-rail--labelled")}
        >
          {stations.map((name, index) => (
            <span
              key={name}
              aria-hidden
              className="station"
              data-state={
                index === at
                  ? "current"
                  : at !== undefined && index < at
                    ? "past"
                    : "future"
              }
            >
              <span className="station-dot" />
              {labelled && (
                <span className="station-name text-xs text-muted-foreground">
                  {name}
                </span>
              )}
            </span>
          ))}
        </span>
      )}
    </span>
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
      <h2 className="text-lg font-semibold">{children}</h2>
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
        已載入 {shown} {unit}，還有 {total - shown} {unit}未載入
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
