import { groupReplyStatus } from "../../shared/group-reply-status.js";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, Send } from "lucide-react";
import type { NotificationFailures, Settings } from "../../shared/types.js";
import { ConnectionSecrets } from "./connection-secrets";
import { linePushService } from "../../shared/group-delivery.js";
import { LINE_QUOTA, linePushPanel, pushCost } from "../../shared/line-quota.js";
import {
  lineGroupReserveLabel,
  linePrivateDefaults,
  linePrivateDigestMinutes,
  linePrivateModeLabels,
  linePrivateModes,
  lineServiceOutageMinutes,
  type LinePrivateMode,
} from "../../shared/line-private.js";
import {
  adminNotificationLabels,
  connectionStatusLabels,
  dataRetentionSecretText,
  discordServiceLabels,
  discordServiceText,
  groupPlatformLabels,
  inferenceStatusLabels,
  networkStatusLabels,
  systemStatusLabels,
} from "../../shared/status-glossary.js";
import {
  readSettingsTab,
  settingsTabs,
  type SettingsTab,
} from "../../shared/settings-tabs.js";
import {
  maxCodexReserve,
  reserveLabel,
} from "../../shared/subscription-quota.js";
import {
  riskyChanges,
  settingsDiff,
  type SettingsChange,
} from "../../shared/settings-diff.js";
import { ConfirmButton } from "./confirm";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Label,
  Progress,
  Separator,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  segmentedListClass,
  segmentedItemClass,
} from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type Account,
  type Request,
  type Run,
  type State,
  ago,
  date,
  healthBadge,
  healthStatus,
} from "./shared";
import { useUnsaved } from "./unsaved";

type Theme = "system" | "light" | "dark";
// 外觀只是個人偏好，存在瀏覽器；讀寫失敗時跟隨系統。
function savedTheme(): Theme {
  try {
    const t = localStorage.getItem("agentflow-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
const prefersDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;
export function applyTheme(theme: Theme = savedTheme()) {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
}
if (typeof window !== "undefined")
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener(
      "change",
      () => savedTheme() === "system" && applyTheme(),
    );

export function pickSettings(s: Settings) {
  return {
    paused: s.paused,
    triage_paused: s.triage_paused ?? false,
    auto_memory: s.auto_memory ?? true,
    code_downloads: s.code_downloads ?? true,
    group_replies: s.group_replies ?? true,
    container_network: s.container_network ?? "isolated",
    rag_enabled: s.rag_enabled,
    ai_mode: s.ai_mode,
    daily_runs: s.daily_runs,
    codex_model: s.codex_model,
    triage_effort: s.triage_effort,
    coding_effort: s.coding_effort,
    daily_budget: s.daily_budget,
    task_budget: s.task_budget,
    task_minutes: s.task_minutes,
    triage_model: s.triage_model,
    coding_model: s.coding_model,
  };
}
const effortLabels: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "極致",
};
const windowLabel = (m: number | null) =>
  m === 300
    ? "5 小時額度"
    : m === 10080
      ? "每週額度"
      : m
        ? `${Math.round(m / 60)} 小時額度`
        : "額度";
const until = (iso: string) => {
  const h = (new Date(iso).getTime() - Date.now()) / 3600000;
  if (h <= 0) return "即將重置";
  if (h < 1) return `${Math.ceil(h * 60)} 分鐘後重置`;
  if (h < 48) return `${Math.round(h)} 小時後重置`;
  return `${Math.round(h / 24)} 天後重置`;
};
const services = [
  { key: "line", name: "LINE", hint: "接收群組訊息與私訊通知" },
  {
    key: "notifications",
    name: "LINE 推播（群組回覆與私訊）",
    hint: "最近一次推播有沒有送達",
  },
  {
    key: LINE_QUOTA,
    name: "LINE 推播額度",
    hint: "本月推播用量；額度用完時推播暫停",
  },
  { key: "github", name: "GitHub App", hint: "讀取專案、建立 Issue 與 PR" },
  {
    key: "codex",
    name: "Codex 訂閱推論",
    hint: "尚未完成真實推論檢查。排程會透過工作使用的訂閱代理確認，不計每日派工次數。",
    mode: "subscription",
  },
  { key: "openai", name: "OpenAI API", hint: "API 模式的 AI", mode: "api" },
  { key: "embedder", name: "本機向量模型", hint: "以中文短句檢查向量推論" },
  { key: "rag_index", name: "向量索引", hint: "最近一次背景建索引狀態" },
  { key: "outcomes", name: "開發經驗檢索", hint: "最近一次同專案任務結果檢索" },
  { key: "retrieval", name: "對話檢索", hint: "最近一次檢索狀態" },
  { key: "runner", name: "隔離執行器", hint: "在獨立容器修改程式" },
  {
    key: "tunnel",
    name: "HTTPS 入口",
    hint: "Cloudflare Tunnel 或 ngrok 固定網址",
  },
  { key: "queue", name: "工作佇列", hint: "訊息與任務排程" },
  { key: "triage", name: "需求辨識", hint: "最近一次判讀結果" },
];

function QuotaCard({
  account,
  reload,
  reserve,
  busy,
  run,
  request,
}: {
  account: Account | null | string;
  reload: () => unknown;
  reserve: number;
  busy: boolean;
  run: Run;
  request: Request;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(reserve);
  const percent = Number(value);
  const dirty = value !== String(reserve);
  useUnsaved("codex-reserve", dirty);
  const valid =
    value !== "" &&
    Number.isInteger(percent) &&
    percent >= 0 &&
    percent <= maxCodexReserve;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Codex 訂閱額度
        </CardTitle>
        <CardDescription>
          與你個人使用 Codex 共用同一個帳號的額度
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw /> 重新整理
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !dirty || busy) return;
            void run(
              () =>
                request("/api/settings/codex-reserve", "PUT", {
                  codex_reserve_percent: percent,
                }),
              "你已儲存個人保留比例",
            ).then((saved) => {
              if (saved) setDraft(null);
            });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="codex-reserve">{reserveLabel}（%）</Label>
            <Input
              id="codex-reserve"
              type="number"
              min={0}
              max={maxCodexReserve}
              step={1}
              required
              disabled={busy}
              value={value}
              aria-describedby="codex-reserve-hint"
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !dirty || !valid}>
            儲存保留比例
          </Button>
          <p
            id="codex-reserve-hint"
            className="w-full text-sm text-muted-foreground"
          >
            你可以保留 0–90% 的額度，填 0 代表不保留。
          </p>
        </form>
        {account === null ? (
          <p className="text-sm text-muted-foreground">讀取中…</p>
        ) : typeof account === "string" ? (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {account}
          </p>
        ) : (
          <>
            {account.allowed === false && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                目前已無法使用一般額度，工作會保留到額度重置後自動重試。
              </p>
            )}
            {account.limits.flatMap((l) =>
              l.windows.map((w, i) => (
                <div key={`${l.id}-${i}`} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">
                      {windowLabel(w.minutes)}
                      {l.name ? `（${l.name}）` : ""}
                    </span>
                    <span className="text-2xl font-semibold tabular-nums">
                      剩 {Math.max(0, Math.round(100 - w.usedPercent))}%
                    </span>
                  </div>
                  <Progress
                    value={Math.min(100, w.usedPercent)}
                    indicatorClassName={cn(
                      w.usedPercent >= 90
                        ? "bg-danger"
                        : w.usedPercent >= 70
                          ? "bg-warn"
                          : "bg-primary",
                    )}
                  />
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>已用 {Math.round(w.usedPercent)}%</span>
                    {w.resetsAt && (
                      <span>{until(w.resetsAt)}（{date(w.resetsAt)}）</span>
                    )}
                  </span>
                </div>
              )),
            )}
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <span>方案 {account.plan ?? "未知"}</span>
              <span>更新於 {ago(account.checkedAt)}</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LinePushForm({
  savedMode,
  savedReserve,
  busy,
  run,
  request,
}: {
  savedMode: LinePrivateMode;
  savedReserve: number;
  busy: boolean;
  run: Run;
  request: Request;
}) {
  const [mode, setMode] = useState(savedMode);
  const [reserve, setReserve] = useState(String(savedReserve));
  const dirty = mode !== savedMode || reserve !== String(savedReserve);
  useUnsaved("settings-line", dirty);
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () =>
            request("/api/settings/line-push", "PUT", {
              line_private_mode: mode,
              line_group_reserve_percent: Number(reserve),
            }),
          "已儲存 LINE 推播設定",
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="line-private-mode">LINE 私訊範圍</Label>
          <select
            id="line-private-mode"
            className="min-h-11 w-full rounded-md border border-muted-foreground bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            value={mode}
            onChange={(event) => setMode(event.target.value as LinePrivateMode)}
            aria-describedby="line-private-hint"
          >
            {linePrivateModes.map((option) => (
              <option key={option} value={option}>
                {linePrivateModeLabels[option]}
              </option>
            ))}
          </select>
          <p id="line-private-hint" className="text-sm text-muted-foreground">
            你預設只會收到待確認、需要處理的失敗、補問，以及持續{" "}
            {lineServiceOutageMinutes} 分鐘的服務異常。
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="line-group-reserve">{lineGroupReserveLabel}</Label>
          <Input
            id="line-group-reserve"
            className="min-h-11 border-muted-foreground"
            type="number"
            min={0}
            max={100}
            step={1}
            required
            value={reserve}
            onChange={(event) => setReserve(event.target.value)}
            aria-describedby="line-group-reserve-hint"
          />
          <p
            id="line-group-reserve-hint"
            className="text-sm text-muted-foreground"
          >
            你可以填 0 到 100，額度只剩你保留的比例時請到看板鈴鐺查看通知。
          </p>
        </div>
      </div>
      <Button
        type="submit"
        className="min-h-11 self-start"
        disabled={busy || !dirty}
      >
        儲存 LINE 推播設定
      </Button>
    </form>
  );
}

function AiCard({
  replyCount,
  settings: s,
  account,
  busy,
  run,
  request,
}: {
  settings: Settings;
  replyCount: number;
  account: Account | null | string;
  busy: boolean;
  run: Run;
  request: Request;
}) {
  type Form = ReturnType<typeof pickSettings>;
  const [form, setForm] = useState(pickSettings(s));
  // SSE 會建立新的設定物件；只同步已儲存值真的變了的那幾個欄位，
  // 例如別處按了暫停，不會把這裡還沒儲存的其他修改一起洗掉。
  const savedSettings = JSON.stringify(pickSettings(s));
  const base = useRef(savedSettings);
  useEffect(() => {
    const prev = JSON.parse(base.current) as Record<string, unknown>;
    const next = JSON.parse(savedSettings) as Record<string, unknown>;
    base.current = savedSettings;
    setForm(
      (f) =>
        Object.fromEntries(
          Object.entries(f).map(([k, v]) => [
            k,
            JSON.stringify(prev[k]) === JSON.stringify(next[k]) ? v : next[k],
          ]),
        ) as Form,
    );
  }, [savedSettings]);
  const dirty = JSON.stringify(form) !== savedSettings;
  useUnsaved("settings-ai", dirty);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const save = (values: Form) =>
    void run(
      () => request("/api/settings", "PUT", values),
      "設定已儲存，新工作會套用",
    );
  // 等管理者確認的危險變更；取消時什麼都不送，表單內容留著。
  const [pending, setPending] = useState<{
    form: Form;
    changes: SettingsChange[];
  } | null>(null);
  const models = typeof account === "object" && account ? account.models : [];
  const fallback = models.find((m) => m.isDefault);
  const current = models.find((m) => m.id === form.codex_model) ?? fallback;
  const efforts = current?.efforts.length
    ? current.efforts
    : ["low", "medium", "high", "xhigh"];
  return (
    <Card>
      <CardHeader>
        <CardTitle id="ai-mode-title" role="heading" aria-level={2}>
          AI 執行模式
        </CardTitle>
        <CardDescription>切換只影響之後開始的判讀與開發</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            // 開放容器網路、改用 API 計費先確認；改回隔離或訂閱、改其他欄位直接儲存。
            const risky = riskyChanges(
              settingsDiff(JSON.parse(savedSettings) as Form, form),
            );
            if (risky.length) setPending({ form, changes: risky });
            else save(form);
          }}
        >
          <div className="space-y-2">
            <label className="work-touch flex items-center gap-2 text-sm">
              <Switch
                aria-describedby="triage-pause-hint"
                checked={form.triage_paused}
                onCheckedChange={(v) => set("triage_paused", v)}
              />
              暫停新需求判讀
            </label>
            <p id="triage-pause-hint" className="text-xs text-muted-foreground">
              LINE
              訊息與圖片照常接收；暫停期間不建立或更新需求，已核准任務仍可執行。取消暫停後會處理尚未判讀的訊息。全域暫停仍優先停止判讀與派工。
            </p>
          </div>
          <label className="work-touch flex items-center gap-2 text-sm">
            <Switch
              checked={form.rag_enabled}
              onCheckedChange={(v) => set("rag_enabled", v)}
            />
            從過去對話與任務找參考資料
          </label>
          <div className="space-y-2">
            <label className="work-touch flex items-center gap-2 text-sm">
              <Switch
                aria-describedby="group-replies-hint"
                checked={form.group_replies}
                onCheckedChange={(v) => set("group_replies", v)}
              />
              在群組回覆
            </label>
            <p
              id="group-replies-hint"
              className="text-xs text-muted-foreground"
            >
              你關閉時所有群組都不回覆，各群組另有自己的設定，目前有{" "}
              {replyCount} 個群組會回覆。
            </p>
          </div>
          <div className="space-y-2">
            <label className="work-touch flex items-center gap-2 text-sm">
              <Switch
                aria-describedby="code-downloads-hint"
                checked={form.code_downloads}
                onCheckedChange={(v) => set("code_downloads", v)}
              />
              開發時允許下載套件
            </label>
            <p
              id="code-downloads-hint"
              className="text-xs text-muted-foreground"
            >
              Codex
              修改程式時可經「系統」頁的下載來源白名單下載套件；其他網址一律封鎖。關閉後只能使用安裝命令預先下載的套件。
            </p>
          </div>
          <div className="space-y-2">
            <label className="work-touch flex items-center gap-2 text-sm">
              <Switch
                aria-describedby="open-network-hint"
                checked={form.container_network === "open"}
                onCheckedChange={(v) =>
                  set("container_network", v ? "open" : "isolated")
                }
              />
              所有專案開放網路（不建議）
            </label>
            <p
              id="open-network-hint"
              className={cn(
                "text-xs",
                form.container_network === "open"
                  ? "text-warn"
                  : "text-muted-foreground",
              )}
            >
              建議你改在個別專案開啟「完全存取」，只影響該專案。
            </p>
            {s.container_network === "open" && (
              <p className="text-sm text-muted-foreground">
                {networkStatusLabels.open}。
              </p>
            )}
          </div>
          <div
            role="radiogroup"
            aria-labelledby="ai-mode-title"
            className="grid gap-2 sm:grid-cols-2"
          >
            {(
              [
                [
                  "subscription",
                  "ChatGPT 訂閱",
                  "用服務專用的 Codex 登入，計入方案額度",
                ],
                ["api", "OpenAI API", "用 API 金鑰，依預估金額記帳"],
              ] as const
            ).map(([id, label, hint]) => (
              <label
                key={id}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors hover:bg-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2",
                  form.ai_mode === id &&
                    "border-primary bg-accent ring-1 ring-primary",
                )}
              >
                <input
                  type="radio"
                  name="ai-mode"
                  value={id}
                  checked={form.ai_mode === id}
                  onChange={() => set("ai_mode", id)}
                  className="sr-only"
                />
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </label>
            ))}
          </div>
          {form.ai_mode === "subscription" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="codex-model">模型</Label>
                <Select
                  value={form.codex_model ?? "default"}
                  onValueChange={(v) =>
                    set("codex_model", v === "default" ? null : v)
                  }
                >
                  <SelectTrigger id="codex-model" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      Codex 預設{fallback ? `（${fallback.name}）` : ""}
                    </SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                    {form.codex_model &&
                      !models.some((m) => m.id === form.codex_model) && (
                        <SelectItem value={form.codex_model}>
                          {form.codex_model}
                        </SelectItem>
                      )}
                  </SelectContent>
                </Select>
                {/* Codex 回傳的模型說明多為英文；只顯示中文說明，介面維持繁體中文。 */}
                {current?.description &&
                  /[一-鿿]/.test(current.description) && (
                    <p className="text-xs text-muted-foreground">
                      {current.description}
                    </p>
                  )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["triage_effort", "需求判讀思考程度"],
                    ["coding_effort", "開發與審查思考程度"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="flex flex-col gap-2">
                    <Label htmlFor={k}>{label}</Label>
                    <Select
                      value={form[k]}
                      onValueChange={(v) => set(k, v as Settings[typeof k])}
                    >
                      <SelectTrigger id={k} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {efforts.map((e) => (
                          <SelectItem key={e} value={e}>
                            {effortLabels[e] ?? e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="daily-runs">每日最多執行次數</Label>
                <Input
                  id="daily-runs"
                  type="number"
                  min={1}
                  max={200}
                  value={form.daily_runs}
                  onChange={(e) => set("daily_runs", Number(e.target.value))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                思考程度越高越仔細，但較慢、用掉較多額度；判讀建議「高」，開發建議「中」或「高」。額度用完時工作會保留並每小時重試，不會改用
                API。登入方式：在主機執行{" "}
                <code className="rounded bg-muted px-1">
                  npm run codex:login
                </code>
                。
              </p>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="daily-budget">每日預估上限（US$）</Label>
                  <Input
                    id="daily-budget"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={form.daily_budget}
                    onChange={(e) =>
                      set("daily_budget", Number(e.target.value))
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="task-budget">單次任務上限（US$）</Label>
                  <Input
                    id="task-budget"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={form.task_budget}
                    onChange={(e) => set("task_budget", Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["triage_model", "需求辨識模型"],
                    ["coding_model", "程式開發模型"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="flex flex-col gap-2">
                    <Label htmlFor={k}>{label}</Label>
                    <Select value={form[k]} onValueChange={(v) => set(k, v)}>
                      <SelectTrigger id={k} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gpt-5.4-mini">
                          GPT-5.4 Mini
                        </SelectItem>
                        <SelectItem value="gpt-6.1-sol">GPT-6.1 Sol</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-minutes">每個任務時間上限（分鐘）</Label>
            <Input
              id="task-minutes"
              type="number"
              min={1}
              max={30}
              value={form.task_minutes}
              onChange={(e) => set("task_minutes", Number(e.target.value))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !dirty}>儲存設定</Button>
            {dirty && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setForm(JSON.parse(savedSettings) as Form)}
                >
                  復原
                </Button>
                <span role="status" className="text-xs text-warn">
                  有修改尚未儲存
                </span>
              </>
            )}
          </div>
        </form>
        <Dialog
          open={!!pending}
          onOpenChange={(open) => !open && setPending(null)}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>確定要套用這些變更？</DialogTitle>
              <DialogDescription>
                以下變更會影響之後開始的判讀與開發，儲存後立即生效。
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-3 text-sm">
              {pending?.changes.map((c) => (
                <li key={c.key} className="rounded-lg bg-warn-soft px-3 py-2">
                  <p className="font-medium text-warn">
                    {c.label}：{c.from} → {c.to}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{c.risk}</p>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">先不要</Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const values = pending?.form;
                  setPending(null);
                  if (values) save(values);
                }}
              >
                確認並儲存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function ThemeCard() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const selectTheme = (value: Theme) => {
    setTheme(value);
    applyTheme(value);
    try {
      localStorage.setItem("agentflow-theme", value);
    } catch {
      // 無法保存時仍套用到這次瀏覽。
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle id="theme-title" role="heading" aria-level={2}>
          介面外觀
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="radiogroup"
          aria-labelledby="theme-title"
          className={cn(segmentedListClass, "h-auto")}
        >
          {(
            [
              ["system", "跟隨系統"],
              ["light", "淺色"],
              ["dark", "深色"],
            ] as const
          ).map(([value, name]) => (
            <label
              key={value}
              data-state={theme === value ? "active" : "inactive"}
              className={cn(
                segmentedItemClass,
                "work-touch h-auto cursor-pointer has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 has-focus-visible:outline-1",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => selectTheme(value)}
                className="sr-only"
              />
              {name}
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsPanel({
  value,
  active,
  children,
}: {
  value: SettingsTab;
  active: SettingsTab;
  children: React.ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      forceMount
      hidden={active !== value}
      className="@container min-w-0"
    >
      <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]">
        {children}
      </div>
    </TabsContent>
  );
}

function AdminNotifications({
  settings, busy, run, request,
}: {
  settings: State["settings"];
  busy: boolean;
  run: Run;
  request: Request;
}) {
  const saved = settings.admin_notify_platform ?? "line";
  const [platform, setPlatform] = useState(saved);
  const [pairing, setPairing] = useState("");
  const [copied, setCopied] = useState(false);
  const dirty = platform !== saved;
  useUnsaved("settings-notifications", dirty);
  const paired = { line: !!settings.admin_line_id, discord: !!settings.admin_discord_id };
  const canSave = dirty && paired[platform] && !busy;
  return (
    <Card role="region" aria-labelledby="admin-notifications-title">
      <CardHeader>
        <CardTitle id="admin-notifications-title" role="heading" aria-level={2}>
          管理者通知
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form className="grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          void run(
            () => request("/api/settings/admin-notifications", "PUT", { admin_notify_platform: platform }),
            "已儲存管理者通知設定",
          );
        }}>
          <label className="text-sm font-medium" htmlFor="admin-notification-platform">
            {adminNotificationLabels.destination}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="admin-notification-platform"
              className="min-h-11 w-full rounded-md border border-muted-foreground bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-48"
              value={platform}
              disabled={busy}
              aria-describedby={!paired[platform] || dirty ? "admin-notification-pairing-hint" : undefined}
              onChange={(event) => {
                setPlatform(event.target.value === "discord" ? "discord" : "line");
                setPairing("");
                setCopied(false);
              }}
            >
              {(["line", "discord"] as const).map((id) => (
                <option key={id} value={id}>
                  {groupPlatformLabels[id]}{!paired[id] && `（${adminNotificationLabels.unpaired}）`}
                </option>
              ))}
            </select>
            <Button type="submit" className="min-h-11" disabled={!canSave}>儲存通知設定</Button>
          </div>
        </form>
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <span>{groupPlatformLabels[saved]} 私訊</span>
          <Badge variant={paired[saved] ? "good" : "outline"}>
            {paired[saved] ? adminNotificationLabels.paired : adminNotificationLabels.unpaired}
          </Badge>
        </p>
        <div aria-live="polite" className="empty:hidden">
          {(!paired[platform] || dirty) && (
            <p id="admin-notification-pairing-hint" className="text-sm text-muted-foreground">
              {paired[platform] && `${groupPlatformLabels[platform]} ${adminNotificationLabels.paired}，可以儲存通知設定。`}
              {!paired[platform] && (dirty
                ? `請先完成 ${groupPlatformLabels[platform]} 配對，再儲存通知設定。`
                : "請先配對以接收私訊。配對前可在看板鈴鐺查看通知。")}
            </p>
          )}
        </div>
        <div>
          <Button variant="outline" className="min-h-11" disabled={busy}
            onClick={() => void run(async () => {
              setCopied(false);
              setPairing((await request<{ code: string }>("/api/pairing", "POST", { platform })).code);
            }, "配對碼 10 分鐘內有效")}
          >
            {paired[platform] ? "重新配對" : "產生配對碼"}
          </Button>
        </div>
        {pairing && (
          <div className="rounded-lg bg-muted p-3 text-sm">
            <p className="text-muted-foreground">
              請在 10 分鐘內私訊 {groupPlatformLabels[platform]} 機器人以下文字。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all text-base font-semibold">配對 {pairing}</code>
              <Button variant="ghost" className="min-h-11 min-w-11"
                onClick={() => void navigator.clipboard?.writeText(`配對 ${pairing}`)
                  .then(() => setCopied(true)).catch(() => {})}
              >
                {copied ? <><Check /> 已複製</> : <><Copy /> 複製</>}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsView({
  tab,
  onTabChange,
  state,
  busy,
  run,
  request,
  account,
  reload,
  owner,
  refreshState,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  account: Account | null | string;
  reload: () => unknown;
  owner: boolean;
  refreshState: () => Promise<boolean>;
}) {
  const s = state.settings;
  const discord = state.health.find((entry) => entry.name === "discord");
  // 依說明文字判斷狀態：「尚未設定」記為正常（選用功能），不能只看 ok。
  const discordStatus = discord
    ? ((
        Object.keys(discordServiceText) as (keyof typeof discordServiceText)[]
      ).find((key) => discord.detail === discordServiceText[key]) ??
      (discord.ok ? "connected" : "disconnected"))
    : "unconfigured";
  // 私訊與群組分開計數（群組依人數計入額度）；過期的重送時略過。
  const failures: NotificationFailures = (
    state as State & { notificationFailures?: NotificationFailures }
  ).notificationFailures ?? {
    direct: state.failedNotifications ?? 0,
    group: 0,
    stale: 0,
  };
  const mode = s.line_private_mode ?? linePrivateDefaults.line_private_mode;
  const reserve =
    s.line_group_reserve_percent ??
    linePrivateDefaults.line_group_reserve_percent;
  const push = linePushPanel(state.health, failures, reserve);
  const estimatedGroups = state.groups.filter((g) =>
    g.platform === "line" && !g.left_at && g.reply_mode !== "off" &&
    (g.member_count == null || (g.member_count_estimate ?? 0) > g.member_count)
  );
  const idleEstimates = estimatedGroups.filter((g) => !g.has_pending_line_push);
  const estimateRow = (g: (typeof estimatedGroups)[number]) => (
    <p key={g.id} className="break-words text-sm text-muted-foreground">
      {g.name}：{g.member_count == null ? "目前人數未知" : `上次查得 ${g.member_count} 人`}，以 {pushCost(g.member_count ?? null, g.member_count_estimate)} 人估算每次推播用量。
    </p>
  );
  const [allServicesOpen, setAllServicesOpen] = useState(false);
  const serviceRows = services
    .filter((i) => !i.mode || i.mode === s.ai_mode)
    .map((i) => {
      const disabled =
        ["embedder", "retrieval", "outcomes"].includes(i.key) && !s.rag_enabled;
      const h = disabled
        ? undefined
        : state.health.find((h) => h.name === i.key);
      const status = healthStatus(h);
      const inference = i.key === "codex";
      // 判讀與檢索在使用時更新，顯示最近一次結果；其他服務由每小時檢查確認，
      // 超過一天沒有再確認的結果不能當成「正常」，只代表上次正常。
      const onUse = [
        "notifications",
        "triage",
        "rag_index",
        "retrieval",
        "outcomes",
      ].includes(i.key);
      const stale =
        !onUse &&
        !h?.inferenceStatus &&
        !!h?.ok &&
        Date.now() - new Date(h.checked_at).getTime() > 86400000;
      const pushService =
        i.key === "notifications"
          ? linePushService(h, push.blocked)
          : undefined;
      const quota = pushService?.quota;
      const detail = pushService ? pushService.detail : h?.detail;
      const action = !disabled && !quota &&
        (stale || status === "failed" || (!h && !onUse && !inference));
      const label = disabled ? connectionStatusLabels.disabled
        : stale ? connectionStatusLabels.stale
        : inference ? inferenceStatusLabels[status]
        : h ? (h.ok ? connectionStatusLabels.healthy : connectionStatusLabels.needsAttention)
        : onUse ? connectionStatusLabels.noRecord : connectionStatusLabels.unchecked;
      return {
        action,
        row: (
          <li
            key={i.key}
            className="flex items-center gap-3 border-b py-2.5 last:border-0"
          >
            <span
              className={cn(
                "size-2 shrink-0 shape-pill bg-border",
                !quota && status === "healthy" && !stale && "bg-good",
                stale && "bg-warn",
                !quota && status === "failed" && "bg-danger",
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{i.name}</span>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {detail ?? i.hint}
                {h && !quota && status !== "unknown" && (
                  <span className={cn("block", stale && "text-warn")}>
                    {onUse ? "最近一次" : "最後確認"} {ago(h.checked_at)}
                    {stale && "，每小時會自動確認；可按「檢查連線」立即更新"}
                  </span>
                )}
              </span>
            </span>
            {!quota && (
              <Badge variant={stale ? "warn" : healthBadge[status]}>
                {label}
              </Badge>
            )}
          </li>
        ),
      };
    });
  const discordNeedsAttention =
    discordStatus === "disconnected" || discordStatus === "configError";
  const counts: Partial<Record<SettingsTab, number>> = {
    notifications: Number(push.blocked) + Number(push.failed > 0),
    connections:
      serviceRows.filter((entry) => entry.action).length +
      Number(discordNeedsAttention),
  };
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 從網址開啟分頁時，只移動分頁列，讓手機也看得到目前選取的標籤。
    const list = tabList.current;
    const selected = list?.querySelector('[aria-selected="true"]');
    if (!list || !selected) return;
    const bounds = list.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    list.scrollLeft +=
      Math.min(0, item.left - bounds.left) +
      Math.max(0, item.right - bounds.right);
  }, [tab]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(readSettingsTab(value))}
      className="min-w-0 gap-4"
    >
      <TabsList
        ref={tabList}
        aria-label="設定分頁"
        className="h-auto max-w-full justify-start overflow-x-auto"
      >
        {(Object.entries(settingsTabs) as [SettingsTab, string][]).map(
          ([id, label]) => {
            const count = counts[id] ?? 0;
            return (
              <TabsTrigger
                key={id}
                value={id}
                className="min-h-11 min-w-11 flex-none px-3 md:min-h-8"
              >
                {label}
                {count > 0 && (
                  <Badge variant="warn" className="px-1.5">
                    <span className="sr-only">
                      {" "}{systemStatusLabels.attention}{" "}
                    </span>
                    {count}
                    <span className="sr-only"> 項</span>
                  </Badge>
                )}
              </TabsTrigger>
            );
          },
        )}
      </TabsList>
      {/* 保留各張卡片的草稿與離頁提醒。 */}
      <SettingsPanel value="ai" active={tab}>
        <AiCard
          replyCount={
            state.groups.filter(
              (g) => groupReplyStatus(g, s, state.health).replies,
            ).length
          }
          settings={s}
          account={account}
          busy={busy}
          run={run}
          request={request}
        />
        {s.ai_mode === "subscription" && (
          <QuotaCard
            account={account}
            reload={reload}
            reserve={s.codex_reserve_percent ?? 0}
            busy={busy}
            run={run}
            request={request}
          />
        )}
      </SettingsPanel>
      <SettingsPanel value="notifications" active={tab}>
        <AdminNotifications
          key={s.admin_notify_platform ?? "line"}
          settings={s}
          busy={busy}
          run={run}
          request={request}
        />
        <Card role="region" aria-labelledby="line-push-title">
          <CardHeader>
            <CardTitle id="line-push-title" role="heading" aria-level={2}>
              LINE 推播（群組回覆與私訊）
            </CardTitle>
            <CardDescription>
              管理者私訊在過去 {linePrivateDigestMinutes}{" "}
              分鐘未送出摘要時會立即送出。接下來累積的私訊會在上一則送出滿{" "}
              {linePrivateDigestMinutes} 分鐘時合併送出，每則最多列 5
              件，完整通知在看板鈴鐺。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {push.usage && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {push.usage}
              </p>
            )}
            {push.forecast && (
              <p className="text-sm text-muted-foreground">{push.forecast}</p>
            )}
            {estimatedGroups.filter((g) => g.has_pending_line_push).map(estimateRow)}
            {idleEstimates.length > 0 && (
              <details className="text-sm">
                <summary className="min-h-11 cursor-pointer py-3">
                  其他群組的推播估值（{idleEstimates.length}）
                </summary>
                {idleEstimates.map(estimateRow)}
              </details>
            )}
            {push.notice && (s.admin_line_id || push.blocked) && (
              <p
                role="status"
                className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
              >
                {push.notice}
              </p>
            )}
            <LinePushForm
              key={`${mode}:${reserve}`}
              savedMode={mode}
              savedReserve={reserve}
              busy={busy}
              run={run}
              request={request}
            />
            {s.admin_notify_platform !== "discord" && s.admin_line_id && (
              <div>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy || push.testDisabled}
                  title="每送一則測試通知會用掉一則推播額度"
                  onClick={() =>
                    void run(
                      () => request("/api/notifications/test", "POST"),
                      "測試通知已送出，請看 LINE 私訊",
                    )
                  }
                >
                  <Send /> 送一則測試通知
                </Button>
              </div>
            )}
            {push.failedText && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
              >
                <span className="min-w-0 flex-1">{push.failedText}</span>
                <ConfirmButton
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  disabled={busy || push.retryDisabled}
                  title="重送失敗的 LINE 通知？"
                  description={push.confirm}
                  confirm="重送"
                  onConfirm={() =>
                    run(
                      () => request("/api/notifications/retry", "POST"),
                      `已重新排入私訊 ${failures.direct} 則、群組 ${failures.group} 則`,
                    )
                  }
                >
                  重送 {push.failed} 則
                </ConfirmButton>
              </div>
            )}
          </CardContent>
        </Card>
      </SettingsPanel>
      <SettingsPanel value="connections" active={tab}>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              服務連線
            </CardTitle>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => request("/api/integrations/check", "POST"),
                    "連線檢查完成",
                  )
                }
              >
                <RefreshCw /> 檢查連線
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ul>
              {!allServicesOpen &&
                serviceRows
                  .filter((entry) => entry.action)
                  .map((entry) => entry.row)}
            </ul>
            {!allServicesOpen && !serviceRows.some((entry) => entry.action) && (
              <p className="text-sm">目前沒有需要處理的服務。</p>
            )}
            <details
              className="mt-3 text-sm"
              onToggle={(e) => setAllServicesOpen(e.currentTarget.open)}
            >
              <summary className="min-h-11 cursor-pointer py-3">
                全部服務
              </summary>
              <ul>{serviceRows.map((entry) => entry.row)}</ul>
            </details>
            <details className="mt-3 text-sm">
              <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">
                Webhook 網址
              </summary>
              <div className="mt-2 flex flex-col gap-1 font-mono text-xs break-all">
                <span>LINE：{state.webhooks.line}</span>
                <span>GitHub：{state.webhooks.github}</span>
              </div>
            </details>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Discord
            </CardTitle>
            <CardAction>
              <Badge
                variant={
                  discordStatus === "connected"
                    ? "good"
                    : discordNeedsAttention
                      ? "danger"
                      : "secondary"
                }
              >
                {discordServiceLabels[discordStatus]}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p role="status" className="text-muted-foreground">
              {discordServiceText[discordStatus]}
            </p>
            <details>
              <summary className="min-h-11 cursor-pointer py-3 font-medium">
                邀請機器人到伺服器
              </summary>
              <p>
                在 Discord
                開發者入口開啟你的應用程式，在「安裝」設定選擇伺服器安裝及機器人權限。複製安裝連結，由有管理伺服器權限的人開啟並選擇伺服器。
              </p>
              <p className="mt-2">
                授予機器人檢視頻道（讀取訊息）、讀取訊息歷史、傳送訊息、在討論串中傳送訊息、加入反應、嵌入連結與附加檔案的權限。
              </p>
              <p className="mt-2">
                在要收訊的文字頻道傳一則訊息，然後到群組頁綁定專案並啟用。
              </p>
              <a
                className="inline-flex min-h-11 items-center underline underline-offset-4"
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
              >
                開啟 Discord 開發者入口
              </a>
            </details>
          </CardContent>
        </Card>
        {owner ? (
          <ConnectionSecrets
            status={state.connectionSecrets}
            request={request}
            refresh={refreshState}
          />
        ) : (
          <p className="col-span-full text-sm">連線金鑰只有擁有者能更新</p>
        )}
      </SettingsPanel>
      <SettingsPanel value="data" active={tab}>
        <ThemeCard />
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              資料保存
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              原文與圖片保存 {s.retention_days}{" "}
              天；撤回訊息立即移除原文並重新審核相關工作。非原文資料每天凌晨 3
              點備份，保留 7 份。
            </p>
            <Separator className="my-3" />
            <p className="text-xs text-muted-foreground">
              {dataRetentionSecretText}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              對話、記憶與任務結果索引
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <dl className="grid grid-cols-2 gap-2">
              {Object.entries({
                message: "對話",
                task: "任務",
                memory: "群組記憶",
                knowledge: "專案記憶",
                outcome: "任務結果",
              }).map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{state.rag.counts[key] ?? 0} 筆</dd>
                </div>
              ))}
            </dl>
            <p>
              最近完成補建：
              {state.rag.completed_at
                ? date(state.rag.completed_at)
                : "尚無紀錄"}
            </p>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy || state.rag.active}
              onClick={() =>
                void run(
                  () => request("/api/rag/backfill", "POST"),
                  "已排程補建索引",
                )
              }
            >
              {state.rag.active ? "補建中" : "補建索引"}
            </Button>
          </CardContent>
        </Card>
      </SettingsPanel>
    </Tabs>
  );
}
