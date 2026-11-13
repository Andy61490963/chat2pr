import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, Send } from "lucide-react";
import type { Settings } from "../../shared/types.js";
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
  TabsList,
  TabsTrigger,
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
    name: "LINE 私訊通知",
    hint: "最近一次私訊通知有沒有送達",
  },
  { key: "github", name: "GitHub App", hint: "讀取專案、建立 Issue 與 PR" },
  {
    key: "codex",
    name: "Codex 訂閱登入",
    hint: "訂閱模式的 AI",
    mode: "subscription",
  },
  { key: "openai", name: "OpenAI API", hint: "API 模式的 AI", mode: "api" },
  { key: "embedder", name: "本機向量模型", hint: "以中文短句檢查向量推論" },
  { key: "rag_index", name: "向量索引", hint: "最近一次背景建索引狀態" },
  { key: "outcomes", name: "開發經驗檢索", hint: "最近一次同專案任務結果檢索" },
  { key: "retrieval", name: "對話檢索", hint: "最近一次檢索狀態" },
  { key: "runner", name: "隔離執行器", hint: "在獨立容器修改程式" },
  { key: "tunnel", name: "HTTPS 入口", hint: "ngrok 固定網址" },
  { key: "queue", name: "工作佇列", hint: "訊息與任務排程" },
  { key: "triage", name: "需求辨識", hint: "最近一次判讀結果" },
];

function QuotaCard({
  account,
  reload,
}: {
  account: Account | null | string;
  reload: () => unknown;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Codex 訂閱額度</CardTitle>
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
                  <span className="text-xs text-muted-foreground">
                    已用 {Math.round(w.usedPercent)}%
                    {w.resetsAt &&
                      ` · ${until(w.resetsAt)}（${date(w.resetsAt)}）`}
                  </span>
                </div>
              )),
            )}
            <p className="text-xs text-muted-foreground">
              方案 {account.plan ?? "未知"} · 更新於 {ago(account.checkedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AiCard({
  settings: s,
  account,
  busy,
  run,
  request,
}: {
  settings: Settings;
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
  const models = typeof account === "object" && account ? account.models : [];
  const fallback = models.find((m) => m.isDefault);
  const current = models.find((m) => m.id === form.codex_model) ?? fallback;
  const efforts = current?.efforts.length
    ? current.efforts
    : ["low", "medium", "high", "xhigh"];
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI 執行模式</CardTitle>
        <CardDescription>切換只影響之後開始的判讀與開發</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => request("/api/settings", "PUT", form),
              "設定已儲存，新工作會套用",
            );
          }}
        >
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
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
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={form.rag_enabled}
              onCheckedChange={(v) => set("rag_enabled", v)}
            />
            本機 RAG
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
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
              開啟時，各群組依群組頁的「在群組回覆」設定回覆「收到」、查詢答案與處理結果；關閉時所有群組都不回覆，通知只私訊給管理者。群組推播會依人數計入
              LINE 的每月推播額度。
            </p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
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
              Codex 修改程式時可下載 npm、PyPI、NuGet
              套件；其他網址一律封鎖。關閉後只能使用安裝命令預先下載的套件。
            </p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                aria-describedby="open-network-hint"
                checked={form.container_network === "open"}
                onCheckedChange={(v) =>
                  set("container_network", v ? "open" : "isolated")
                }
              />
              完全開放容器網路
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
              開啟後，Codex
              開發、測試與審查時可直接連網際網路與公司內網（包含專案設定檔中的正式資料庫），可實際執行整合測試與
              SQL。群組訊息若誤導
              AI，也可能直接改動這些系統；所有資料庫操作會列在任務說明中供你檢查。
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
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
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={form.ai_mode === id}
                onClick={() => set("ai_mode", id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                  form.ai_mode === id &&
                    "border-primary bg-accent ring-1 ring-primary",
                )}
              >
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
          {form.ai_mode === "subscription" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label>模型</Label>
                <Select
                  value={form.codex_model ?? "default"}
                  onValueChange={(v) =>
                    set("codex_model", v === "default" ? null : v)
                  }
                >
                  <SelectTrigger className="w-full">
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
                    <Label>{label}</Label>
                    <Select
                      value={form[k]}
                      onValueChange={(v) => set(k, v as Settings[typeof k])}
                    >
                      <SelectTrigger className="w-full">
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
                    <Label>{label}</Label>
                    <Select value={form[k]} onValueChange={(v) => set(k, v)}>
                      <SelectTrigger className="w-full">
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
      </CardContent>
    </Card>
  );
}

function ThemeCard() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  return (
    <Card>
      <CardHeader>
        <CardTitle>介面外觀</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs
          value={theme}
          onValueChange={(v) => {
            const t = v as Theme;
            setTheme(t);
            applyTheme(t);
            try {
              localStorage.setItem("agentflow-theme", t);
            } catch {
              // 無法保存時仍套用到這次瀏覽。
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="system">跟隨系統</TabsTrigger>
            <TabsTrigger value="light">淺色</TabsTrigger>
            <TabsTrigger value="dark">深色</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function SettingsView({
  state,
  busy,
  run,
  request,
  account,
  reload,
}: {
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  account: Account | null | string;
  reload: () => unknown;
}) {
  const s = state.settings;
  const [pairing, setPairing] = useState("");
  const [copied, setCopied] = useState(false);
  const failed = state.failedNotifications ?? 0;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        {s.ai_mode === "subscription" && (
          <QuotaCard account={account} reload={reload} />
        )}
        <Card>
          <CardHeader>
            <CardTitle>對話、記憶與任務結果索引</CardTitle>
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
        <AiCard
          settings={s}
          account={account}
          busy={busy}
          run={run}
          request={request}
        />
      </div>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>服務連線</CardTitle>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
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
              {services
                .filter((i) => !i.mode || i.mode === s.ai_mode)
                .map((i) => {
                  const disabled =
                    ["embedder", "retrieval", "outcomes"].includes(i.key) &&
                    !s.rag_enabled;
                  const h = disabled
                    ? undefined
                    : state.health.find((h) => h.name === i.key);
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
                    !!h?.ok &&
                    Date.now() - new Date(h.checked_at).getTime() > 86400000;
                  return (
                    <li
                      key={i.key}
                      className="flex items-center gap-3 border-b py-2.5 last:border-0"
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full bg-border",
                          h?.ok && !stale && "bg-good",
                          stale && "bg-warn",
                          h && !h.ok && "bg-danger",
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium">{i.name}</span>
                        <span className="text-xs break-all text-muted-foreground">
                          {h?.detail ?? i.hint}
                          {h && (
                            <span className={cn("block", stale && "text-warn")}>
                              {onUse ? "最近一次" : "最後確認"}{" "}
                              {ago(h.checked_at)}
                              {stale &&
                                "，每小時會自動確認；可按「檢查連線」立即更新"}
                            </span>
                          )}
                        </span>
                      </span>
                      <Badge
                        variant={
                          h
                            ? stale
                              ? "warn"
                              : h.ok
                                ? "good"
                                : "danger"
                            : "secondary"
                        }
                      >
                        {disabled
                          ? "未啟用"
                          : h
                            ? stale
                              ? "待確認"
                              : h.ok
                                ? "正常"
                                : "需處理"
                            : // 使用時才更新的項目沒有紀錄，代表還沒用到，不是漏了檢查。
                              onUse
                              ? "尚無紀錄"
                              : "未檢查"}
                      </Badge>
                    </li>
                  );
                })}
            </ul>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
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
            <CardTitle>LINE 私訊通知</CardTitle>
            <CardDescription>
              只在需要你決定、執行異常或 PR 完成時私訊你
            </CardDescription>
            {s.admin_line_id && (
              <CardAction>
                <Badge variant="good">已配對</Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPairing(
                      (await request<{ code: string }>("/api/pairing", "POST"))
                        .code,
                    );
                  }, "配對碼 10 分鐘內有效")
                }
              >
                {s.admin_line_id ? "重新配對" : "產生配對碼"}
              </Button>
              {s.admin_line_id && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => request("/api/notifications/test", "POST"),
                      "測試通知已送出，請看 LINE 私訊",
                    )
                  }
                >
                  <Send /> 送一則測試通知
                </Button>
              )}
            </div>
            {failed > 0 && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
              >
                <span className="min-w-0 flex-1">
                  有 {failed} 則通知重試 3 次仍送不出去。請先用「服務連線」確認
                  LINE 正常，再重送。
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => request("/api/notifications/retry", "POST"),
                      `已重新排入 ${failed} 則通知`,
                    )
                  }
                >
                  重送 {failed} 則
                </Button>
              </div>
            )}
            {pairing && (
              <div className="rounded-lg bg-muted p-3 text-sm">
                <p className="text-muted-foreground">在機器人的私訊傳送：</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-base font-semibold">
                    配對 {pairing}
                  </code>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void navigator.clipboard
                        ?.writeText(`配對 ${pairing}`)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => {})
                    }
                  >
                    {copied ? (
                      <>
                        <Check /> 已複製
                      </>
                    ) : (
                      <>
                        <Copy /> 複製
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <ThemeCard />
        <Card>
          <CardHeader>
            <CardTitle>資料保存</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              原文與圖片保存 {s.retention_days}{" "}
              天；撤回訊息立即移除原文並重新審核相關工作。非原文資料每天凌晨 3
              點備份，保留 7 份。
            </p>
            <Separator className="my-3" />
            <p className="text-xs text-muted-foreground">
              機密只能透過本機設定頁修改，這裡不會顯示金鑰。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
