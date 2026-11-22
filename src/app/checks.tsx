import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  hostUnavailableAlertHours,
  hostUnavailablePrefix,
  type CheckRunView,
  type ScheduledCheck,
  type SqlCondition,
  type SystemIssue,
} from "../../shared/checks";
import type { CheckEnvironmentView } from "../../shared/check-environment";
import type { ProjectDatabaseView } from "../../shared/project-database";
import { checkAttentionLabels, checkListLabels } from "../../shared/status-glossary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import { type Request, type State, ago, date, message, writeQuery } from "./shared";
import { ConfirmButton } from "./confirm";
import { useGuard, useUnsaved } from "./unsaved";

type Listed = ScheduledCheck & {
  last_summary: string | null;
  /** SQL 檢查的專案沒有登記資料庫連線。 */
  missing_connection?: boolean;
  /** 目前這段連續「系統暫時無法執行」的開始時間。 */
  host_unavailable_since?: string | null;
  /** 最近一次卡在需要管理者處理的系統設定問題（映像缺失、子網路用完等）。 */
  system_issue?: SystemIssue | null;
  environment?: CheckEnvironmentView;
};

/** 試跑結果只留在畫面上（伺服器不記錄），依檢查與版本保存。 */
type Trial = {
  outcome: "ok" | "alert" | "error";
  summary: string;
  at: string;
  version: number;
};
const trialLabel = { ok: "正常", alert: "異常", error: "執行失敗" };
const trialTone = {
  ok: "bg-good-soft text-good",
  alert: "bg-danger-soft text-danger",
  error: "bg-warn-soft text-warn",
};
type Note = { text: string; tone: "info" | "error" };

const hhmm = (v: string) =>
  new Date(v).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** 最近一次是系統暫時無法執行（執行器或檢查環境的問題，不計入連續失敗）。 */
function hostTrouble(c: Listed) {
  if (
    c.status !== "active" ||
    !c.host_unavailable_since ||
    !c.last_summary?.startsWith(hostUnavailablePrefix)
  )
    return null;
  return {
    reason: c.last_summary.slice(hostUnavailablePrefix.length),
    overdue:
      Date.now() - new Date(c.host_unavailable_since).getTime() >
      hostUnavailableAlertHours * 3600000,
  };
}

function executionBlocked(c: Listed, host: ReturnType<typeof hostTrouble>) {
  return (
    !!host ||
    !!c.system_issue ||
    c.environment?.state === "failed" ||
    c.status === "failed" ||
    (c.status === "active" && c.consecutive_errors > 0)
  );
}

function readAttentionFilter() {
  return new URLSearchParams(location.search).get("filter") === "attention";
}

const runTone = {
  ok: "text-muted-foreground",
  alert: "text-danger",
  error: "text-warn",
};
const dotTone = { ok: "bg-good", alert: "bg-danger", error: "bg-warn" };
const recentShown = 5;

/**
 * 最近結果：色點只作總覽（各自有 aria-label），下方逐列寫出時間、結果與摘要，
 * 手機不能懸停也看得到每次失敗的原因。預設最近 5 筆，其餘可展開。
 */
function RecentRuns({ runs }: { runs: CheckRunView[] }) {
  const [all, setAll] = useState(false);
  if (!runs.length) return null;
  const shown = all ? runs : runs.slice(0, recentShown);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">最近結果</span>
        <ol
          className="flex flex-wrap gap-1"
          aria-label={`最近 ${runs.length} 次結果總覽，由舊到新`}
        >
          {[...runs].reverse().map((r) => (
            <li key={r.id}>
              <span
                role="img"
                aria-label={`${date(r.started_at)} ${trialLabel[r.outcome]}`}
                title={`${date(r.started_at)} ${trialLabel[r.outcome]}`}
                className={`block size-3 rounded-full ${dotTone[r.outcome]}`}
              />
            </li>
          ))}
        </ol>
      </div>
      <ol className="flex flex-col gap-1 text-xs" aria-label="最近結果明細">
        {shown.map((r) => (
          <li key={r.id} className={`break-words ${runTone[r.outcome]}`}>
            <span className="tabular-nums">{date(r.started_at)}</span>・
            <span className="font-medium">{trialLabel[r.outcome]}</span>・
            {r.summary}
          </li>
        ))}
      </ol>
      {runs.length > recentShown && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? `只顯示最近 ${recentShown} 筆`
            : `顯示更早的 ${runs.length - recentShown} 筆`}
        </Button>
      )}
    </div>
  );
}

/** 換到專案頁（經 App 的換頁流程，未存修改會先詢問）。 */
const toProjects = (e: MouseEvent) => {
  e.preventDefault();
  history.pushState(null, "", "/projects");
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/** 檢查環境（#19）：每個檢查專用的檢查容器與網路，保留重用、閒置逾時才清除。 */
function environmentText(e: CheckEnvironmentView | undefined, c: Listed) {
  if (c.missing_connection) return "缺少資料庫連線，無法建立";
  if (!e) return null;
  if (e.state === "kept")
    return `保留中・上次使用 ${ago(e.lastUsedAt)}・預計 ${date(e.expiresAt)} 清除`;
  if (e.state === "failed") return `建立失敗（${date(e.at)}）：${e.message}`;
  if (e.state === "unknown") return `狀態不明：${e.detail}`;
  return "未建立（下次執行時建立）";
}

const statusLabel: Record<
  ScheduledCheck["status"],
  [string, "warn" | "good" | "secondary" | "danger"]
> = {
  awaiting_approval: ["待核准", "warn"],
  active: ["執行中", "good"],
  paused: ["已暫停", "secondary"],
  failed: ["檢查失敗已暫停", "danger"],
};
const stateLabel: Record<
  ScheduledCheck["state"],
  [string, "good" | "danger" | "secondary"]
> = {
  unknown: ["尚未判定", "secondary"],
  ok: ["正常", "good"],
  alert: [checkAttentionLabels.equipment, "danger"],
};
const kindLabel = {
  sql: "SQL 唯讀查詢",
  http: "HTTP 健康檢查",
  tcp: "TCP 連線",
};
const schedule = (c: Pick<ScheduledCheck, "interval_minutes" | "daily_at">) =>
  c.interval_minutes
    ? `每 ${c.interval_minutes} 分鐘`
    : `每天 ${c.daily_at}（臺北時間）`;

const blank = {
  group_id: "",
  project_id: "",
  name: "",
  kind: "sql" as ScheduledCheck["kind"],
  target: "",
  column: "",
  op: ">" as SqlCondition["op"],
  value: "0",
  listColumn: "",
  contains: "",
  every: "60",
  mode: "interval" as "interval" | "daily",
  daily_at: "08:00",
  notify: "both" as ScheduledCheck["notify"],
  quiet_from: "",
  quiet_to: "",
  alert_text: "",
  recovered_text: "",
  rationale: "",
  investigate: true,
};
type Draft = typeof blank;

const toDraft = (c: ScheduledCheck): Draft => {
  const cond = c.condition as Partial<SqlCondition> & { contains?: string };
  return {
    group_id: c.group_id,
    project_id: c.project_id ?? "",
    name: c.name,
    kind: c.kind,
    target: c.target,
    column: cond.column ?? "",
    op: cond.op ?? ">",
    value: String(cond.value ?? "0"),
    listColumn: cond.listColumn ?? "",
    contains: cond.contains ?? "",
    every: String(c.interval_minutes ?? 60),
    mode: c.interval_minutes ? "interval" : "daily",
    daily_at: c.daily_at ?? "08:00",
    notify: c.notify,
    quiet_from: c.quiet_from ?? "",
    quiet_to: c.quiet_to ?? "",
    alert_text: c.alert_text,
    recovered_text: c.recovered_text,
    rationale: c.rationale,
    investigate: c.investigate,
  };
};
const toBody = (d: Draft) => ({
  group_id: d.group_id,
  project_id: d.project_id || null,
  name: d.name,
  kind: d.kind,
  target: d.target,
  condition:
    d.kind === "sql"
      ? {
          column: d.column,
          op: d.op,
          value: Number.isNaN(Number(d.value)) ? d.value : Number(d.value),
          ...(d.listColumn ? { listColumn: d.listColumn } : {}),
        }
      : d.kind === "http" && d.contains
        ? { contains: d.contains }
        : {},
  interval_minutes: d.mode === "interval" ? Number(d.every) : null,
  daily_at: d.mode === "daily" ? d.daily_at : null,
  notify: d.notify,
  quiet_from: d.quiet_from || null,
  quiet_to: d.quiet_to || null,
  alert_text: d.alert_text,
  recovered_text: d.recovered_text,
  rationale: d.rationale,
  investigate: d.investigate,
});

const field = "rounded-md border bg-background px-2 py-1.5 text-sm";

/**
 * 新增或修改表單。由父層以檢查 id 當 key：換成另一個檢查時重新掛載、欄位換成該檢查的內容；
 * 有未存修改時向 useUnsaved 回報，切換或取消前由父層先詢問。
 */
function CheckForm({
  state,
  request,
  initial,
  busy,
  submit,
  cancel,
}: {
  state: State;
  request: Request;
  initial: Draft;
  busy: boolean;
  submit: (d: Draft) => void;
  cancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [saved] = useState(() => JSON.stringify(initial));
  useUnsaved("check-form", JSON.stringify(d) !== saved);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const projects = state.projects.filter((p) =>
    state.groups.find((g) => g.id === d.group_id)?.project_ids?.includes(p.id),
  );
  // 從清單下方點「修改」時表單在畫面外；掛載時捲到表單並聚焦第一個欄位。
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" });
    ref.current
      ?.querySelector<HTMLElement>("input,select,textarea")
      ?.focus({ preventScroll: true });
  }, []);
  // SQL 檢查要用專案登記的資料庫連線：標示哪些專案還沒登記（只是提示，仍可先儲存）。
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const ids = projects.map((p) => p.id).join(",");
  useEffect(() => {
    if (d.kind !== "sql" || !ids) return;
    let active = true;
    for (const id of ids.split(","))
      void request<ProjectDatabaseView>(`/api/projects/${id}/database`)
        .then(
          (v) =>
            active && setConnected((m) => ({ ...m, [id]: !!v.connection })),
        )
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [d.kind, ids, request]);
  const noConnection = (id: string) =>
    d.kind === "sql" && connected[id] === false;
  return (
    <form
      ref={ref}
      id="check-form"
      className="flex scroll-mt-4 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(d);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="flex flex-col gap-1">
          名稱
          <Input
            value={d.name}
            maxLength={80}
            onChange={(e) => set("name", e.target.value)}
            placeholder="機台狀態回報是否中斷"
          />
        </Label>
        <Label className="flex flex-col gap-1">
          通知群組
          <select
            className={field}
            value={d.group_id}
            onChange={(e) => set("group_id", e.target.value)}
          >
            <option value="">選擇群組…</option>
            {state.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Label>
        <Label className="flex flex-col gap-1">
          檢查方式
          <select
            className={field}
            value={d.kind}
            onChange={(e) => set("kind", e.target.value as Draft["kind"])}
          >
            <option value="sql">SQL 唯讀查詢（使用專案登記的資料庫）</option>
            <option value="http">HTTP 健康檢查</option>
            <option value="tcp">TCP 連線</option>
          </select>
        </Label>
        <Label className="flex flex-col gap-1">
          專案{d.kind === "sql" ? "（必填）" : "（選填，用於異常時請 AI 調查）"}
          <select
            className={field}
            value={d.project_id}
            onChange={(e) => set("project_id", e.target.value)}
          >
            <option value="">不指定</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {noConnection(p.id) ? "（未登記資料庫連線）" : ""}
              </option>
            ))}
          </select>
          {d.project_id && noConnection(d.project_id) && (
            <span className="text-xs font-normal text-danger">
              這個專案還沒有登記資料庫連線：可以先儲存，但要先到
              <a href="/projects" className="underline" onClick={toProjects}>
                專案頁
              </a>
              設定連線才能核准。
            </span>
          )}
        </Label>
      </div>
      <Label className="flex flex-col gap-1">
        {d.kind === "sql"
          ? "SELECT 查詢（只能讀取，會在一定回滾的交易中執行）"
          : d.kind === "http"
            ? "網址"
            : "主機:連接埠"}
        {d.kind === "sql" ? (
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={d.target}
            onChange={(e) => set("target", e.target.value)}
            placeholder="SELECT COUNT(*) AS stale FROM EQM_STATUS WHERE last_report < DATEADD(minute,-30,GETDATE())"
          />
        ) : (
          <Input
            value={d.target}
            onChange={(e) => set("target", e.target.value)}
            placeholder={
              d.kind === "http" ? "http://10.0.0.5/health" : "10.0.0.21:502"
            }
          />
        )}
      </Label>
      {d.kind === "sql" && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <span>當第一列的</span>
          <Input
            className="w-32"
            value={d.column}
            onChange={(e) => set("column", e.target.value)}
            placeholder="欄位（$rows=筆數）"
          />
          <select
            className={field}
            value={d.op}
            onChange={(e) => set("op", e.target.value as Draft["op"])}
          >
            {([">", ">=", "<", "<=", "=", "!="] as const).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <Input
            className="w-24"
            value={d.value}
            onChange={(e) => set("value", e.target.value)}
          />
          <span>時算異常，通知列出</span>
          <Input
            className="w-32"
            value={d.listColumn}
            onChange={(e) => set("listColumn", e.target.value)}
            placeholder="欄位（選填）"
          />
        </div>
      )}
      {d.kind === "http" && (
        <Label className="flex flex-col gap-1">
          回應需包含的文字（選填；非 2xx、逾時或不包含就算異常）
          <Input
            value={d.contains}
            onChange={(e) => set("contains", e.target.value)}
          />
        </Label>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          className={field}
          value={d.mode}
          onChange={(e) => set("mode", e.target.value as Draft["mode"])}
        >
          <option value="interval">固定間隔</option>
          <option value="daily">每天固定時間</option>
        </select>
        {d.mode === "interval" ? (
          <>
            每{" "}
            <Input
              className="w-20"
              type="number"
              min={15}
              value={d.every}
              onChange={(e) => set("every", e.target.value)}
            />{" "}
            分鐘（最短 15）
          </>
        ) : (
          <>
            每天{" "}
            <Input
              className="w-24"
              value={d.daily_at}
              onChange={(e) => set("daily_at", e.target.value)}
            />
            （臺北時間）
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        通知
        <select
          className={field}
          value={d.notify}
          onChange={(e) => set("notify", e.target.value as Draft["notify"])}
        >
          <option value="both">群組與管理者私訊</option>
          <option value="group">只發群組</option>
          <option value="admin">只私訊管理者</option>
        </select>
        靜音時段（只通知管理者）
        <Input
          className="w-20"
          value={d.quiet_from}
          onChange={(e) => set("quiet_from", e.target.value)}
          placeholder="22:00"
        />
        到
        <Input
          className="w-20"
          value={d.quiet_to}
          onChange={(e) => set("quiet_to", e.target.value)}
          placeholder="07:00"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="flex flex-col gap-1">
          異常時的訊息（選填）
          <Input
            value={d.alert_text}
            onChange={(e) => set("alert_text", e.target.value)}
            placeholder="有機台超過 30 分鐘沒有回報"
          />
        </Label>
        <Label className="flex flex-col gap-1">
          恢復時的訊息（選填）
          <Input
            value={d.recovered_text}
            onChange={(e) => set("recovered_text", e.target.value)}
            placeholder="機台回報已恢復正常"
          />
        </Label>
      </div>
      <Label className="flex flex-col gap-1">
        判斷依據（給核准者看）
        <Textarea
          rows={2}
          value={d.rationale}
          onChange={(e) => set("rationale", e.target.value)}
        />
      </Label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={d.investigate}
          onCheckedChange={(v) => set("investigate", v === true)}
        />
        變成異常時自動請 AI 調查可能原因（每天最多一次，會用 Codex 額度）
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          儲存（需要核准才會執行）
        </Button>
        <Button type="button" variant="ghost" onClick={cancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

/** 定期檢查頁：列出每個檢查的狀態與最近結果；管理者可以建立、試跑、核准、暫停與修改。 */
export function ChecksView({
  state,
  request,
  admin,
  visit,
}: {
  state: State;
  request: Request;
  admin: boolean;
  visit: number;
}) {
  // null 表示還沒載入成功過：不能顯示「還沒有定期檢查」。
  const [checks, setChecks] = useState<Listed[] | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(readAttentionFilter);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<CheckRunView[]>([]);
  const [editing, setEditing] = useState<ScheduledCheck | "new" | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [trials, setTrials] = useState<Record<string, Trial>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const guard = useGuard();
  const load = useCallback(async () => {
    try {
      setChecks(await request<Listed[]>("/api/checks"));
      setLoadError(null);
    } catch (e) {
      // 輪詢失敗時保留原本的列表與試跑結果，只另外顯示錯誤。
      setLoadError(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    const syncFilter = () => {
      if (location.pathname === "/checks") setAttentionOnly(readAttentionFilter());
    };
    syncFilter();
    window.addEventListener("popstate", syncFilter);
    return () => window.removeEventListener("popstate", syncFilter);
  }, [visit]);
  useEffect(() => {
    if (!open) return;
    void request<{ runs: CheckRunView[] }>(`/api/checks/${open}`)
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]));
  }, [open, request, checks]);
  /** fn 回傳字串就用它當提示，否則用 done；兩者都沒有就不覆蓋目前的提示。 */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      const text = typeof r === "string" && r ? r : done;
      if (text) setNote({ text, tone: "info" });
      await load();
    } catch (e) {
      setNote({ text: message(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const trial = (c: Listed) =>
    void act(async () => {
      setTesting(c.id);
      try {
        const r = await request<{ outcome: Trial["outcome"]; summary: string }>(
          `/api/checks/${c.id}/test`,
          "POST",
        );
        setTrials((t) => ({
          ...t,
          [c.id]: { ...r, at: new Date().toISOString(), version: c.version },
        }));
      } finally {
        setTesting(null);
      }
    });
  const edit = (next: ScheduledCheck | "new" | null) => {
    // 再點同一個檢查的「修改」：表單已經是它，只捲回表單，不丟掉正在改的內容。
    if (next !== null && next !== "new" && editing !== null) {
      if (editing !== "new" && editing.id === next.id) {
        document.getElementById("check-form")?.scrollIntoView({
          block: "start",
        });
        return;
      }
    }
    guard(() => setEditing(next), { prefixes: ["check-form"] });
  };
  const groupName = (id: string) =>
    state.groups.find((g) => g.id === id)?.name ?? id;
  const selectFilter = (attention: boolean) => {
    setAttentionOnly(attention);
    writeQuery([["filter", attention ? "attention" : "", ""]]);
  };
  const rows = (checks ?? []).map((check) => {
    const host = hostTrouble(check);
    return { check, host, blocked: executionBlocked(check, host) };
  });
  const visibleRows = attentionOnly
    ? rows.filter(
        ({ check, blocked }) =>
          check.state === "alert" || check.missing_connection || blocked,
      )
    : rows;
  // 同一種系統設定問題會讓所有檢查一起卡住：頁首每種問題只顯示一次，並列出受影響的數量。
  const issues = new Map<string, { issue: SystemIssue; count: number }>();
  for (const c of checks ?? [])
    if (c.system_issue) {
      const seen = issues.get(c.system_issue.kind);
      issues.set(c.system_issue.kind, {
        issue: c.system_issue,
        count: (seen?.count ?? 0) + 1,
      });
    }
  return (
    <div className="flex flex-col gap-4">
      <Card id="scheduled-checks">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>定期檢查</CardTitle>
            <CardDescription>
              核准後依排程自動檢查，狀態改變時通知，檢查本身不呼叫 AI。
            </CardDescription>
          </div>
          {admin && editing === null && (
            <Button className="min-h-11" onClick={() => edit("new")}>
              新增定期檢查
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {[...issues.values()].map(({ issue, count }) => (
            <div
              key={issue.kind}
              role="status"
              className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              <p className="font-medium">
                定期檢查因系統設定問題暫停執行：{issue.label}。
              </p>
              <p>
                {issue.fix}（受影響的檢查：{count}{" "}
                個，檢查狀態不變、不計入連續失敗）
              </p>
            </div>
          ))}
          {note &&
            (note.tone === "error" ? (
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {note.text}
              </p>
            ) : (
              <p
                role="status"
                className="rounded-lg bg-muted px-3 py-2 text-sm"
              >
                {note.text}
              </p>
            ))}
          {loadError && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              <span className="min-w-0 flex-1">
                {checks === null
                  ? `讀不到定期檢查：${loadError}`
                  : `重新整理失敗，以下是上次載入的內容：${loadError}`}
              </span>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                重試
              </Button>
            </div>
          )}
          {editing && (
            <CheckForm
              key={editing === "new" ? "new" : editing.id}
              state={state}
              request={request}
              busy={busy}
              initial={editing === "new" ? blank : toDraft(editing)}
              cancel={() => edit(null)}
              submit={(d) =>
                void act(async () => {
                  if (editing === "new")
                    await request("/api/checks", "POST", toBody(d));
                  else
                    await request(`/api/checks/${editing.id}`, "PUT", {
                      version: editing.version,
                      ...toBody(d),
                    });
                  setEditing(null);
                }, "已儲存，請試跑確認後核准")
              }
            />
          )}
          {checks === null && !loadError && (
            <p className="text-sm text-muted-foreground">載入中…</p>
          )}
          {checks !== null && !checks.length && !editing && (
            <div className="space-y-2 rounded-lg border px-4 py-5 text-sm">
              <p className="font-medium">{checkListLabels.empty}</p>
              <p className="text-muted-foreground">
                {admin
                  ? "按「新增定期檢查」建立第一項檢查。"
                  : "在綁定專案的 LINE 群組輸入「/任務」提出檢查需求。"}
              </p>
              <p className="text-muted-foreground">
                例如每小時檢查一次示範服務是否能連線。
              </p>
            </div>
          )}
          {!!rows.length && (
            <div role="group" aria-label="檢查篩選" className="flex flex-wrap gap-2">
              <Button
                className="min-h-11"
                variant={attentionOnly ? "outline" : "default"}
                aria-pressed={!attentionOnly}
                onClick={() => selectFilter(false)}
              >
                {checkListLabels.all}
              </Button>
              <Button
                className="min-h-11"
                variant={attentionOnly ? "default" : "outline"}
                aria-pressed={attentionOnly}
                onClick={() => selectFilter(true)}
              >
                {checkListLabels.attention}
              </Button>
            </div>
          )}
          {!!rows.length && !visibleRows.length && (
            <p role="status" className="text-sm text-muted-foreground">
              {checkListLabels.attentionEmpty}
            </p>
          )}
          <ul aria-label="定期檢查清單" className="flex flex-col gap-2">
            {visibleRows.map(({ check: c, host, blocked }) => {
              const tried =
                trials[c.id]?.version === c.version ? trials[c.id] : null;
              return (
                <li key={c.id} className="rounded-lg border">
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
                    aria-expanded={open === c.id}
                    onClick={() => setOpen(open === c.id ? null : c.id)}
                  >
                    <span className="min-w-0 grow basis-40 font-medium [overflow-wrap:anywhere]">
                      {c.name}
                    </span>
                    <Badge variant={stateLabel[c.state][1]}>
                      {stateLabel[c.state][0]}
                    </Badge>
                    <Badge variant={statusLabel[c.status][1]}>
                      {statusLabel[c.status][0]}
                    </Badge>
                    {c.missing_connection && (
                      <Badge variant="danger">{checkAttentionLabels.connection}</Badge>
                    )}
                    {blocked && (
                      <Badge variant={host?.overdue ? "danger" : "warn"}>
                        {checkAttentionLabels.system}
                      </Badge>
                    )}
                    <span className="flex w-full flex-wrap gap-x-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      <span>{kindLabel[c.kind]}</span>
                      <span>{schedule(c)}</span>
                      <span>{groupName(c.group_id)}</span>
                    </span>
                  </button>
                  {open === c.id && (
                    <div className="flex flex-col gap-2 border-t px-3 py-3 text-sm">
                      <p className="break-all font-mono text-xs">{c.target}</p>
                      {c.rationale && (
                        <p className="text-muted-foreground">
                          判斷依據：{c.rationale}
                        </p>
                      )}
                      {c.missing_connection && (
                        <p className="rounded-lg bg-danger-soft px-3 py-2 text-danger">
                          這個專案還沒有登記資料庫連線，檢查無法執行，也不能核准或恢復。
                          <a
                            href="/projects"
                            className="underline"
                            onClick={toProjects}
                          >
                            前往專案頁設定資料庫連線
                          </a>
                        </p>
                      )}
                      {host && (
                        <p
                          className={`rounded-lg px-3 py-2 ${host.overdue ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`}
                        >
                          系統暫時無法執行（{host.reason}）
                          {c.next_run_at
                            ? `，將於 ${hhmm(c.next_run_at)} 重試`
                            : ""}
                          。這類問題不計入連續失敗，恢復後自動繼續。
                          {host.overdue &&
                            `已超過 ${hostUnavailableAlertHours} 小時，請到系統頁確認執行器與 Docker。`}
                        </p>
                      )}
                      {c.system_issue && (
                        <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
                          等待系統問題排除（{c.system_issue.label}）
                          {c.next_run_at
                            ? `，將於 ${date(c.next_run_at)} 重試`
                            : ""}
                          。這類問題不計入連續失敗，檢查狀態不變。
                          {c.system_issue.fix}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        上次：
                        {c.last_run_at
                          ? `${ago(c.last_run_at)}・${c.last_summary ?? ""}`
                          : "尚未執行"}
                        {c.next_run_at && `　下次：${date(c.next_run_at)}`}
                        　第 {c.version} 版
                        {c.approved_by ? `・${c.approved_by} 核准` : ""}
                      </p>
                      {(c.environment || c.missing_connection) && (
                        <p
                          className={`text-xs ${c.missing_connection || c.environment?.state === "failed" ? "text-danger" : "text-muted-foreground"}`}
                        >
                          檢查環境：{environmentText(c.environment, c)}
                        </p>
                      )}
                      <RecentRuns key={c.id} runs={runs} />
                      {admin && tried && (
                        <p
                          role="status"
                          className={`rounded-lg px-3 py-2 ${trialTone[tried.outcome]}`}
                        >
                          試跑結果（{date(tried.at)}）：
                          {trialLabel[tried.outcome]}・{tried.summary}
                          {c.status === "awaiting_approval" &&
                            (tried.outcome === "ok"
                              ? "　試跑正常，可以核准。"
                              : "　試跑未通過，建議先修改。")}
                        </p>
                      )}
                      {admin && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => trial(c)}
                          >
                            {testing === c.id ? "試跑中…" : "試跑"}
                          </Button>
                          {c.status === "awaiting_approval" && (
                            <Button
                              size="sm"
                              disabled={busy || c.missing_connection}
                              onClick={() =>
                                void act(
                                  () =>
                                    request(
                                      `/api/checks/${c.id}/approve`,
                                      "POST",
                                      { version: c.version },
                                    ),
                                  "已核准，開始依排程執行",
                                )
                              }
                            >
                              核准並啟用
                            </Button>
                          )}
                          {(c.status === "active" || c.status === "failed") && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () =>
                                    request(
                                      `/api/checks/${c.id}/pause`,
                                      "POST",
                                    ),
                                  "已暫停",
                                )
                              }
                            >
                              暫停
                            </Button>
                          )}
                          {(c.status === "paused" || c.status === "failed") &&
                            c.approved_version === c.version && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy || c.missing_connection}
                                onClick={() =>
                                  void act(
                                    () =>
                                      request(
                                        `/api/checks/${c.id}/resume`,
                                        "POST",
                                      ),
                                    "已恢復",
                                  )
                                }
                              >
                                恢復
                              </Button>
                            )}
                          {c.environment?.state === "kept" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () =>
                                    request(
                                      `/api/checks/${c.id}/environment/clear`,
                                      "POST",
                                    ),
                                  "已清除檢查環境，下次執行時重新建立",
                                )
                              }
                            >
                              立即清除環境
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => edit(c)}
                          >
                            修改
                          </Button>
                          <ConfirmButton
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            title="刪除定期檢查？"
                            description={`刪除「${c.name}」後不會再依排程執行，它的執行紀錄會一併刪除，檢查環境也會清除。這個動作無法復原。`}
                            confirm="刪除檢查"
                            onConfirm={() =>
                              act(
                                () => request(`/api/checks/${c.id}`, "DELETE"),
                                "已刪除",
                              )
                            }
                          >
                            刪除
                          </ConfirmButton>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <details className="border-t text-sm">
            <summary className="min-h-11 cursor-pointer py-3 font-medium">
              怎麼運作
            </summary>
            <ul className="list-disc space-y-2 pb-3 pl-5 text-muted-foreground">
              <li>
                從正常變成異常或恢復正常時才發通知。可另外設定異常時請 AI 調查。
              </li>
              <li>
                檢查本身連續失敗 3
                次會暫停並通知管理者。執行器或檢查環境出問題時，系統會延後重試，這些問題不計入失敗次數。需要調整系統設定時，這一頁會顯示處理方式。
              </li>
              <li>SQL 檢查需要資料庫連線，請先在專案頁登記連線再核准。</li>
              <li>
                每項檢查在專用容器執行，網路只通到檢查目標。系統會重用檢查環境，直到超過系統頁設定的閒置期限，或檢查、連線設定有變更。
              </li>
            </ul>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
