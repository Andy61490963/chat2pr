import { useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Settings2,
  FileSearch,
} from "lucide-react";
import type { Project, Task } from "../../shared/types.js";
import { statusLabels } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox, Label } from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "./confirm";
import {
  type Act,
  type Audit,
  type State,
  type View,
  ago,
  collapseRepeats,
  Empty,
  groupName,
  Linkified,
  LoadMore,
  moving,
  projectName,
  SectionTitle,
  StatCard,
  StatusBadge,
  StatusIcon,
  Stepper,
} from "./shared";

function setupSteps(state: State) {
  const ok = (name: string) => state.health.find((h) => h.name === name)?.ok;
  const ai = state.settings.ai_mode === "api" ? "openai" : "codex";
  return [
    {
      done: !!(ok("github") && ok("line") && ok("runner")),
      label: "服務連線正常",
      hint: "在設定頁按「檢查連線」",
      view: "settings" as View,
    },
    {
      done: !!ok(ai),
      label: ai === "codex" ? "服務的 Codex 已登入訂閱" : "OpenAI API 可用",
      hint:
        ai === "codex"
          ? "在主機執行 npm run codex:login，再檢查連線"
          : "在本機設定頁填入 API 金鑰",
      view: "settings" as View,
    },
    {
      done: state.projects.some((p) => p.enabled && p.validated_at),
      label: "至少一個專案通過驗證",
      hint: "新增專案並驗證環境",
      view: "projects" as View,
    },
    {
      done: state.groups.some((g) => g.enabled && g.project_ids.length),
      label: "群組已綁定專案並啟用",
      hint: "把機器人加進群組後，在群組頁勾選專案",
      view: "groups" as View,
    },
    {
      done: !!state.settings.admin_line_id,
      label: "LINE 私訊通知已配對",
      hint: "在設定頁產生配對碼",
      view: "settings" as View,
    },
    {
      done: !state.settings.paused,
      label: "開始自動派工",
      hint: "右上角切換",
      view: "inbox" as View,
    },
  ];
}

export function InboxView({
  state,
  needs,
  busy,
  go,
  admin,
  showTasks,
  open,
  act,
  more,
}: {
  state: State;
  needs: Task[];
  busy: boolean;
  go: (v: View) => void;
  admin: boolean;
  showTasks: (filter: string) => void;
  open: (id: string) => unknown;
  act: Act;
  more: () => unknown;
}) {
  const setup = setupSteps(state);
  const left = setup.filter((s) => !s.done);
  const working = state.tasks.filter((t) => moving.includes(t.status));
  const ready = state.tasks.filter((t) => t.status === "ready");
  const week = Date.now() - 7 * 86400000;
  const merged = state.tasks.filter(
    (t) => t.status === "merged" && new Date(t.updated_at).getTime() > week,
  );
  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-4">
        <StatCard
          label="需要你處理"
          value={needs.length}
          hint={needs.length ? "審核、補充或重試" : "目前沒有待決定的事"}
          icon={<CircleAlert />}
          tone={needs.length ? "warn" : "default"}
          onClick={() => showTasks("todo")}
        />
        <StatCard
          label="進行中"
          value={working.length}
          hint="排程、開發與驗證"
          icon={<Loader2 />}
          tone="info"
          onClick={() => showTasks("moving")}
        />
        <StatCard
          label="待你合併"
          value={ready.length}
          hint="PR 已建立"
          icon={<GitPullRequest />}
          tone={ready.length ? "good" : "default"}
          onClick={() => showTasks("ready")}
        />
        <StatCard
          label="近 7 天已合併"
          value={merged.length}
          hint={`累計 ${state.tasks.length} 個需求`}
          icon={<GitMerge />}
          onClick={() => showTasks("closed")}
        />
      </div>
      {left.length > 0 && (
        <Card className="gap-3">
          <CardContent>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">開始使用</h2>
              <span className="text-sm text-muted-foreground">
                已完成 {setup.length - left.length} / {setup.length}
              </span>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {left.map((s) => (
                <li
                  key={s.label}
                  className="flex items-start gap-3 rounded-lg bg-muted/60 px-3 py-2.5"
                >
                  <Circle className="mt-0.5 size-4 text-warn" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{s.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.hint}
                    </span>
                  </span>
                  {/* 成員進不了設定、專案與群組頁，不給會被彈回的連結。 */}
                  {admin && s.view !== "inbox" && (
                    <Button variant="link" size="sm" onClick={() => go(s.view)}>
                      前往 <ChevronRight />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <section>
        <SectionTitle count={needs.length}>需要你處理</SectionTitle>
        {needs.length ? (
          <div className="flex flex-col gap-3">
            {needs.map((t) => (
              <DecisionCard
                key={t.id}
                task={t}
                state={state}
                busy={busy}
                open={open}
                act={act}
                go={admin ? go : undefined}
              />
            ))}
          </div>
        ) : (
          <Card className="py-1">
            <Empty compact icon={<CheckCircle2 />} title="都處理完了">
              有需求需要你決定時，會出現在這裡並私訊通知你。
            </Empty>
          </Card>
        )}
      </section>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <section>
            <SectionTitle count={working.length}>進行中</SectionTitle>
            <Card className="gap-0 py-1">
              {working.length ? (
                working.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    state={state}
                    open={open}
                    steps
                  />
                ))
              ) : (
                <Empty
                  compact
                  icon={<Loader2 />}
                  title="目前沒有執行中的工作"
                >
                  核准的需求會在這裡顯示開發進度。
                </Empty>
              )}
            </Card>
          </section>
          <section>
            <SectionTitle count={ready.length}>待你合併</SectionTitle>
            <Card className="gap-0 py-1">
              {ready.length ? (
                ready.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 border-b px-5 py-3 last:border-0"
                  >
                    <StatusIcon status={t.status} />
                    <button
                      className="flex min-w-0 flex-1 flex-col text-left"
                      onClick={() => open(t.id)}
                    >
                      <span className="truncate font-medium">{t.title}</span>
                      <span className="text-sm text-muted-foreground">
                        {projectName(state, t)}
                      </span>
                    </button>
                    {t.pr_url && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={t.pr_url} target="_blank" rel="noreferrer">
                          PR #{t.pr_number} <ArrowUpRight />
                        </a>
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <Empty compact icon={<GitPullRequest />} title="沒有等待合併的 PR">
                  Codex 完成並通過驗證後，PR 會出現在這裡。
                </Empty>
              )}
            </Card>
          </section>
        </div>
        <ActivityFeed state={state} open={open} more={more} />
      </div>
    </div>
  );
}

// 動態依種類給圖示與色調；系統維運紀錄（備份、復原）淡化顯示，避免蓋過任務動態。
const activityKinds: Record<
  string,
  { icon: typeof Activity; tone: string; system?: boolean }
> = {
  ready: { icon: GitPullRequest, tone: "text-good" },
  answered: { icon: MessageSquareText, tone: "text-good" },
  merged: { icon: GitMerge, tone: "text-good" },
  approve: { icon: Check, tone: "text-muted-foreground" },
  adopt: { icon: Check, tone: "text-muted-foreground" },
  started: { icon: Play, tone: "text-muted-foreground" },
  attempt: { icon: Bot, tone: "text-muted-foreground" },
  verification: { icon: ScanSearch, tone: "text-muted-foreground" },
  triage: { icon: FileSearch, tone: "text-muted-foreground" },
  retrieval: { icon: FileSearch, tone: "text-muted-foreground" },
  error: { icon: CircleAlert, tone: "text-danger" },
  retry: { icon: RefreshCw, tone: "text-warn" },
  settings: { icon: Settings2, tone: "text-muted-foreground" },
  backup: { icon: Archive, tone: "text-muted-foreground", system: true },
  recovery: { icon: RotateCcw, tone: "text-muted-foreground", system: true },
};
const dayLabel = (v: string) => {
  const d = new Date(v),
    today = new Date();
  const key = (x: Date) =>
    x.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
  if (key(d) === key(today)) return "今天";
  if (key(d) === key(new Date(today.getTime() - 86400000))) return "昨天";
  return d.toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
};

// 失敗的完整原因在「需要你處理」的卡片與任務詳情裡；動態只留一句，避免同一段文字重複出現。
const brief = (a: Audit) => {
  if (a.kind !== "verification" && a.kind !== "error") return a.detail;
  if (a.detail.startsWith("驗證未通過，請修正：")) return "驗證未通過，交回修正";
  const gaveUp = "一次自動修復後仍未通過驗證";
  const at = a.detail.indexOf(gaveUp);
  if (at >= 0) return a.detail.slice(0, at + gaveUp.length);
  return a.detail.split("\n")[0];
};

function ActivityFeed({
  state,
  open,
  more,
}: {
  state: State;
  open: (id: string) => unknown;
  more: () => unknown;
}) {
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(10);
  const rows = collapseRepeats(
    state.activity.filter((a) => all || !activityKinds[a.kind]?.system),
  );
  const items = rows.slice(0, limit);
  return (
    <section>
      <SectionTitle
        action={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setAll(!all)}
          >
            {all ? "隱藏系統紀錄" : "顯示系統紀錄"}
          </Button>
        }
      >
        最近動態
      </SectionTitle>
      <Card className="py-4">
        <CardContent>
          {items.length ? (
            <ol className="flex flex-col">
              {items.map((a, i) => {
                const k = activityKinds[a.kind] ?? {
                  icon: Activity,
                  tone: "text-muted-foreground",
                };
                const Icon = k.icon;
                const day = dayLabel(a.created_at);
                return (
                  <li key={a.id} className="flex flex-col">
                    {day !== (i > 0 && dayLabel(items[i - 1].created_at)) && (
                      <span
                        className={cn(
                          "pb-2 text-xs font-medium text-muted-foreground",
                          i > 0 && "pt-2",
                        )}
                      >
                        {day}
                      </span>
                    )}
                    <div className="flex gap-3">
                      <span className="flex flex-col items-center">
                        <span
                          className={cn(
                            "grid size-5 shrink-0 place-items-center [&_svg]:size-3.5",
                            k.tone,
                          )}
                        >
                          <Icon />
                        </span>
                        {i < items.length - 1 && (
                          <span className="w-px flex-1 bg-border" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col pb-3 text-sm">
                        {a.task_id && (
                          <button
                            className="truncate text-left font-medium hover:text-brand-foreground hover:underline"
                            onClick={() => open(a.task_id!)}
                          >
                            {a.task_title ?? "查看任務"}
                          </button>
                        )}
                        <span
                          className={cn(
                            "line-clamp-2 [overflow-wrap:anywhere]",
                            (a.task_id || k.system) && "text-muted-foreground",
                          )}
                        >
                          <Linkified text={brief(a)} />
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {ago(a.created_at)}
                          {a.times > 1 && `・連續 ${a.times} 次`}
                        </span>
                      </span>
                    </div>
                  </li>
                );
              })}
              {rows.length > limit && (
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground"
                    onClick={() => setLimit(limit + 20)}
                  >
                    看更多
                  </Button>
                </li>
              )}
              {/* 已載入的都看完了，再往前的要向伺服器多要。 */}
              {rows.length <= limit && (
                <li>
                  <LoadMore
                    shown={state.activity.length}
                    total={state.totals?.activity}
                    unit="筆動態"
                    more={async () => {
                      await more();
                      setLimit((n) => n + 20);
                    }}
                  />
                </li>
              )}
            </ol>
          ) : (
            <Empty compact icon={<Activity />} title="還沒有動態" />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DecisionCard({
  task: t,
  state,
  busy,
  open,
  act,
  go,
}: {
  task: Task;
  state: State;
  busy: boolean;
  open: (id: string) => unknown;
  act: Act;
  go?: (v: View) => void;
}) {
  const pick = t.status === "awaiting_approval" && !t.project_id;
  const reason =
    t.status === "awaiting_approval"
      ? pick
        ? "AI 無法判斷要改哪個專案"
        : (t.risk_reasons[0] ?? t.missing[0] ?? "需求等待確認")
      : (t.last_error?.replace(/^Error: /, "") ?? statusLabels[t.status]);
  return (
    <Card className="gap-0 py-4">
      <CardContent>
        <button
          className="flex w-full flex-col gap-1 text-left"
          onClick={() => open(t.id)}
        >
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="size-3.5" /> {groupName(state, t)}
            <span>·</span>
            <FolderGit2 className="size-3.5" /> {projectName(state, t)}
            <span>·</span>
            更新於 {ago(t.updated_at)}
          </span>
          <span className="text-base font-semibold">{t.title}</span>
          <span
            className={cn(
              "flex items-start gap-1.5 text-sm",
              pick
                ? "text-info"
                : t.status === "failed"
                  ? "text-danger"
                  : "text-warn",
            )}
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{reason}</span>
          </span>
        </button>
        {pick ? (
          <AssignProject task={t} state={state} busy={busy} act={act} go={go} />
        ) : (
          <>
            {t.status === "awaiting_approval" && t.suggestions.length > 0 && (
              <SuggestionList task={t} busy={busy} open={() => open(t.id)} />
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {t.status === "awaiting_approval" && !t.missing.length && (
                <Button
                  disabled={busy}
                  onClick={() => open(t.id)}
                >
                  <Check /> 檢視專案並確認
                </Button>
              )}
              {t.status === "awaiting_approval" && t.missing.length > 0 && (
                <Button
                  variant={t.suggestions.length ? "outline" : "default"}
                  onClick={() => open(t.id)}
                >
                  {t.suggestions.length ? "都不是，自己補充" : "補充需求"}
                </Button>
              )}
              {["failed", "budget_wait"].includes(t.status) && (
                <Button
                  disabled={busy}
                  onClick={() => void act(t, "retry", {}, "已重新排程")}
                >
                  <RefreshCw /> 重試
                </Button>
              )}
              {t.status === "awaiting_approval" && <RejectButton task={t} busy={busy} act={act} />}
              <Button variant="ghost" onClick={() => open(t.id)}>
                詳情
              </Button>
              {t.status === "failed" && (
                <ConfirmButton
                  variant="ghost"
                  className="ml-auto text-muted-foreground"
                  disabled={busy}
                  title="關閉這個任務？"
                  description="關閉後不再重試，會從「需要你處理」移除；之後要做，可以在任務詳情按「重新開啟」。"
                  confirm="關閉任務"
                  onConfirm={() => act(t, "cancel", {}, "已關閉任務")}
                >
                  關閉任務
                </ConfirmButton>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SuggestionList({
  task: t,
  busy,
  open,
}: {
  task: Task;
  busy: boolean;
  open: () => void;
}) {
  const sensitive = t.risk_reasons.length > 0;
  return (
    <div className="@container mt-4 flex flex-col gap-2">
      <span className="text-sm font-medium">
        可選方案
        <span className="ml-2 font-normal text-muted-foreground">
          到詳情確認專案與方案
        </span>
      </span>
      <div className="grid gap-2 @2xl:grid-cols-3">
      {t.suggestions.map((s, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              <span className="mr-1.5 text-muted-foreground tabular-nums">
                {i + 1}.
              </span>
              {s.label}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{s.summary}</p>
            {s.acceptance.length > 0 && (
              <ul className="mt-1.5 list-disc pl-5 text-xs text-muted-foreground">
                {s.acceptance.map((a, j) => (
                  <li key={j}>{a}</li>
                ))}
              </ul>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy || sensitive}
            title={sensitive ? "涉及敏感範圍，請補充後再核准" : undefined}
            onClick={open}
          >
            檢視專案與方案
          </Button>
        </div>
      ))}
      </div>
    </div>
  );
}

export function AssignProject({
  task: t,
  state,
  busy,
  act,
  go,
}: {
  task: Task;
  state: State;
  busy: boolean;
  act: Act;
  // 只有管理者能去群組與專案頁；沒給就只說明原因。
  go?: (v: View) => void;
}) {
  const group = state.groups.find((g) => g.id === t.group_id);
  const bound = state.projects.filter((p) => group?.project_ids.includes(p.id));
  // 找不到儲存庫、還沒驗證或已停用的專案派不了工：列出來讓人知道原因，但不能選。
  const blocked = (p: Project) =>
    p.repo_missing_at
      ? "找不到儲存庫"
      : !p.validated_at
        ? "尚未驗證"
        : !p.enabled
          ? "已停用"
          : "";
  const options = bound.filter((p) => !blocked(p));
  const [pick, setPick] = useState(options.length === 1 ? options[0].id : "");
  const [remember, setRemember] = useState(false);
  const chosen = options.find((p) => p.id === pick);
  const rule = chosen ? `「${t.title}」這類需求改 ${chosen.name}` : "";
  return (
    <div className="mt-4 flex flex-col gap-3">
      <span className="text-sm font-medium">這次需求要處理哪個專案？</span>
      <div className="flex flex-wrap gap-2">
        {bound.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={pick === p.id ? "default" : "outline"}
            disabled={!!blocked(p)}
            onClick={() => setPick(p.id)}
          >
            {pick === p.id && <Check />}
            <span className="min-w-0 whitespace-normal break-all text-left">
              {p.name}（{p.repo}）{blocked(p) && `・${blocked(p)}`}
            </span>
          </Button>
        ))}
      </div>
      {!options.length && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {bound.length
            ? "這個群組綁定的專案目前都不能派工，請先讓專案通過驗證並啟用。"
            : "這個群組還沒綁定專案，綁定後才能指定。"}
          {go ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => go(bound.length ? "projects" : "groups")}
            >
              {bound.length ? "前往專案" : "前往群組設定"} <ChevronRight />
            </Button>
          ) : (
            "請管理者處理。"
          )}
        </p>
      )}
      {chosen && (
        <Label className="font-normal text-muted-foreground">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
          />
          記住：{rule}
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !chosen}
          onClick={() =>
            void act(
              t,
              "assign",
              { project_id: pick, remember: remember ? rule : undefined },
              remember ? "已指定專案並記住" : "已指定專案",
            )
          }
        >
          指定專案
        </Button>
        <RejectButton task={t} busy={busy} act={act} />
      </div>
    </div>
  );
}

function RejectButton({
  task: t,
  busy,
  act,
}: {
  task: Task;
  busy: boolean;
  act: Act;
}) {
  return (
    <ConfirmButton
      variant="outline"
      disabled={busy}
      title="拒絕這個需求？"
      description={`「${t.title}」拒絕後不會派工；之後反悔，可以在任務詳情按「重新開啟」。`}
      confirm="拒絕需求"
      onConfirm={() => act(t, "reject", {}, "已拒絕需求")}
    >
      拒絕
    </ConfirmButton>
  );
}

export function TaskRow({
  task: t,
  state,
  open,
  steps,
  hide,
}: {
  task: Task;
  state: State;
  open: (id: string) => unknown;
  steps?: boolean;
  hide?: "project" | "group" | "none";
}) {
  // 分段標題已顯示的專案或群組，不在每列重複。
  const meta = [
    t.mode === "query" && "查詢",
    hide !== "group" && groupName(state, t),
    hide !== "project" && projectName(state, t),
    t.issue_number && `Issue #${t.issue_number}`,
    `更新於 ${ago(t.updated_at)}`,
  ].filter(Boolean);
  return (
    <button
      className="flex w-full items-center gap-3 border-b px-5 py-3 text-left transition-colors last:border-0 hover:bg-muted/50"
      onClick={() => open(t.id)}
    >
      <StatusIcon status={t.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{t.title}</span>
        <span className="text-sm text-muted-foreground">
          {meta.join(" · ")}
        </span>
        {steps && <Stepper status={t.status} query={t.mode === "query"} />}
      </span>
      <StatusBadge status={t.status} />
    </button>
  );
}
