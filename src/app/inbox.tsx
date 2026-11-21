import {
  inboxStatusLabels,
  notificationLabels,
  projectLabels,
  taskStatusFilterLabels,
} from "../../shared/status-glossary.js";
import type { TaskStatusFilter } from "../../shared/task-list.js";
import { taskListTitle } from "../../shared/task-title.js";
import {
  activityDay,
  activityDetail,
  activityStatus,
  groupActivity,
  type ActivityGroup,
} from "../../shared/activity-groups.js";
import { useId, useRef, useState } from "react";
import type { PickList } from "../../shared/pick-list.js";
import { PickListForm } from "./pick-list";
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
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Settings2,
  FileSearch,
} from "lucide-react";
import {
  statusLabels,
  taskGroups,
  type EndTaskSelection,
  type Project,
  type Task,
} from "../../shared/types.js";
import {
  failureBrief,
  fixPageLabels,
  parseFailure,
  primaryFix,
  waitHint,
} from "../../shared/failure-text.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "./confirm";
import {
  type Act,
  type State,
  type View,
  ago,
  attention,
  Clamped,
  countOf,
  Empty,
  groupName,
  Linkified,
  LoadMore,
  memoryHold,
  moving,
  projectName,
  ready as readyStatuses,
  RunProgressLine,
  SectionTitle,
  StationTrack,
  waiting as waitingStatuses,
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
      done: !!(state.settings.admin_notify_platform === "discord"
        ? state.settings.admin_discord_id : state.settings.admin_line_id),
      label: "管理者私訊通知已配對",
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
  endTasks,
  resolvePickList,
  more,
}: {
  state: State;
  needs: Task[];
  busy: boolean;
  go: (v: View, projectId?: string | null) => void;
  admin: boolean;
  showTasks: (filter: TaskStatusFilter | "closed") => void;
  /** amend 為 true 時打開任務詳情並直接展開補充需求編輯。 */
  open: (id: string, amend?: boolean) => unknown;
  act: Act;
  endTasks: (
    tasks: EndTaskSelection[],
    reason: string,
    notify: boolean,
  ) => Promise<boolean>;
  resolvePickList: (list: PickList, ids: string[]) => Promise<boolean>;
  more: () => unknown;
}) {
  const [selected, setSelected] = useState(new Map<string, EndTaskSelection>());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const reasonId = useId();
  const decisionSection = useRef<HTMLElement>(null);
  const endButton = useRef<HTMLButtonElement>(null);
  const eligible = new Map<string, EndTaskSelection>();
  for (const { id, status, version } of needs) {
    const endableStatus = taskGroups.attention.find(
      (allowed) => allowed === status,
    );
    if (endableStatus) eligible.set(id, { id, status: endableStatus, version });
  }
  const toggleTask = (id: string, checked: boolean) => {
    const task = eligible.get(id);
    setSelected((previous) => {
      const next = new Map(previous);
      if (checked && task) next.set(id, task);
      else next.delete(id);
      return next;
    });
  };
  const submitEnd = async () => {
    setConfirmEnd(false);
    if (!(await endTasks([...selected.values()], reason.trim(), notify)))
      return;
    if (
      document.activeElement === endButton.current ||
      document.activeElement === document.body
    )
      decisionSection.current?.focus();
    setSelected(new Map());
    setReason("");
    setNotify(true);
  };
  const setup = setupSteps(state);
  const left = setup.filter((s) => !s.done);
  // 清單用已載入的任務（未結束的伺服器一律載入）；摘要的數字用伺服器的實際數量。
  const working = state.tasks.filter((t) => moving.includes(t.status));
  const ready = state.tasks.filter((t) => readyStatuses.includes(t.status));
  const held = state.tasks.filter((t) => waitingStatuses.includes(t.status));
  const needCount = countOf(state, attention);
  const movingCount = countOf(state, moving);
  const readyCount = countOf(state, readyStatuses);
  const lists = admin ? (state.pickLists ?? []) : [];
  const clear =
    needCount === 0 &&
    movingCount === 0 &&
    readyCount === 0 &&
    needs.length === 0 &&
    working.length === 0 &&
    ready.length === 0 &&
    lists.length === 0;
  const week = Date.now() - 7 * 86400000;
  const mergedWeek =
    state.totals?.mergedWeek ??
    state.tasks.filter(
      (t) => t.status === "merged" && new Date(t.updated_at).getTime() > week,
    ).length;
  return (
    <div
      className={cn(
        "work-surface flex min-w-0 flex-col",
        clear ? "gap-4" : "gap-7",
      )}
    >
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
      <section
        ref={decisionSection}
        tabIndex={-1}
        aria-labelledby="inbox-todo"
        className={batchFocus}
      >
        {clear ? (
          <Card className="gap-1 px-5 py-4">
            <h2 id="inbox-todo" className="font-semibold">
              {inboxStatusLabels.clear}
            </h2>
            <p className="text-sm text-muted-foreground">
              {inboxStatusLabels.clearDescription}
            </p>
          </Card>
        ) : (
          <TaskSectionTitle
            id="inbox-todo"
            count={needCount}
            open={() => showTasks("todo")}
          >
            {notificationLabels.action}
          </TaskSectionTitle>
        )}
        {!clear && admin && (eligible.size > 0 || selected.size > 0) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button
              type="button"
              variant="ghost"
              className={batchControl}
              aria-disabled={busy || eligible.size === 0}
              onClick={() => {
                if (!busy && eligible.size) setSelected(eligible);
              }}
            >
              全選本頁
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={batchControl}
              aria-disabled={busy || selected.size === 0}
              onClick={() => {
                if (!busy && selected.size) setSelected(new Map());
              }}
            >
              清除選取
            </Button>
            {selected.size > 0 && (
              <Button
                ref={endButton}
                type="button"
                className={batchControl}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) setConfirmEnd(true);
                }}
              >
                結束選取的 {selected.size} 張任務
              </Button>
            )}
          </div>
        )}
        {lists.length > 0 && (
          <section
            aria-label="需要你決定"
            className="work-ledger mb-4 divide-y"
          >
            {lists.map((list) => (
              <PickListForm
                key={`${list.id}:${list.version}`}
                list={list}
                group={
                  state.groups.find((group) => group.id === list.groupId)
                    ?.name ?? "LINE 群組"
                }
                busy={busy}
                resolve={async (ids) => {
                  if (await resolvePickList(list, ids))
                    decisionSection.current?.focus();
                }}
              />
            ))}
          </section>
        )}
        {needs.length ? (
          <div className="work-ledger divide-y">
            {needs.map((t) => (
              <DecisionCard
                key={t.id}
                task={t}
                state={state}
                busy={busy}
                open={open}
                act={act}
                go={admin ? go : undefined}
                selection={
                  admin && eligible.has(t.id) ? (
                    <label className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md">
                      <input
                        type="checkbox"
                        className={batchCheckbox}
                        checked={selected.has(t.id)}
                        disabled={busy}
                        onChange={(event) =>
                          toggleTask(t.id, event.target.checked)
                        }
                      />
                      <span className="sr-only">
                        選取「{taskListTitle(t)}」
                      </span>
                    </label>
                  ) : undefined
                }
              />
            ))}
          </div>
        ) : !clear && lists.length === 0 ? (
          <Card className="py-1">
            <Empty
              compact
              icon={<CheckCircle2 />}
              title={inboxStatusLabels.clear}
            >
              有需求需要你決定時，你會在這裡看到它，也會收到私訊。
            </Empty>
          </Card>
        ) : null}
        {!clear && admin && (
          <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
            <DialogContent
              showCloseButton={false}
              className="max-h-[calc(100dvh-2rem)] overflow-y-auto motion-reduce:animate-none"
              onCloseAutoFocus={(event) => {
                if (
                  !endButton.current &&
                  document.activeElement === document.body
                ) {
                  event.preventDefault();
                  decisionSection.current?.focus();
                }
              }}
            >
              <DialogHeader className="text-left">
                <DialogTitle>結束 {selected.size} 張任務？</DialogTitle>
                <DialogDescription>
                  你結束的任務不會派工，之後可在任務詳情重新開啟。
                  {!notify && "你這次不會通知群組。"}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor={reasonId}>
                  結束原因（選填，僅記在任務活動）
                </Label>
                <Textarea
                  id={reasonId}
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  className={cn(
                    batchFocus,
                    "border-muted-foreground motion-reduce:transition-none",
                  )}
                />
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className={batchCheckbox}
                  checked={notify}
                  onChange={(event) => setNotify(event.target.checked)}
                />
                依群組回覆設定通知
              </label>
              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(batchControl, "border-muted-foreground")}
                  >
                    保留任務
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  className={batchControl}
                  onClick={() => void submitEnd()}
                >
                  結束任務
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </section>
      {/* 等待額度的工作會自動繼續，不需要決定；放在較低調的段落，只說明什麼時候恢復。 */}
      {held.length > 0 && (
        <section aria-labelledby="waiting-title">
          <div className="mb-3 flex items-center gap-2">
            <TaskSectionTitle
              id="waiting-title"
              count={countOf(state, waitingStatuses)}
              open={() => showTasks("waiting")}
              subdued
            >
              {`${taskStatusFilterLabels.waiting}（會自動繼續）`}
            </TaskSectionTitle>
            {admin && (
              <Button
                variant="link"
                size="sm"
                className="ml-auto h-auto p-0"
                onClick={() => go("settings")}
              >
                調整額度設定
              </Button>
            )}
          </div>
          <div className="work-ledger">
            {held.map((t) => (
              <WaitingRow
                key={t.id}
                task={t}
                state={state}
                busy={busy}
                open={open}
                act={act}
              />
            ))}
          </div>
        </section>
      )}
      <div
        className={cn(
          "grid grid-cols-1",
          clear
            ? "gap-4"
            : "gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]",
        )}
      >
        <div className="flex flex-col gap-8">
          {!clear && (
            <>
              <section aria-labelledby="inbox-moving">
                <TaskSectionTitle
                  id="inbox-moving"
                  count={movingCount}
                  open={() => showTasks("moving")}
                >
                  {taskStatusFilterLabels.moving}
                </TaskSectionTitle>
                <div className="work-ledger">
                  {working.length ? (
                    working.map((t) => (
                      <TaskRow key={t.id} task={t} state={state} open={open} />
                    ))
                  ) : (
                    <Empty
                      compact
                      icon={<Loader2 />}
                      title="目前沒有執行中的工作"
                    >
                      你核准需求後，就能在這裡追蹤進度。
                    </Empty>
                  )}
                </div>
              </section>
              <section aria-labelledby="inbox-ready">
                <TaskSectionTitle
                  id="inbox-ready"
                  count={readyCount}
                  open={() => showTasks("ready")}
                >
                  {statusLabels.ready}
                </TaskSectionTitle>
                <div className="work-ledger">
                  {ready.length ? (
                    ready.map((t) => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        state={state}
                        open={open}
                        trailing={
                          t.pr_url && (
                            <Button variant="outline" size="sm" asChild>
                              <a
                                href={t.pr_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                PR #{t.pr_number} <ArrowUpRight />
                              </a>
                            </Button>
                          )
                        }
                      />
                    ))
                  ) : (
                    <Empty
                      compact
                      icon={<GitPullRequest />}
                      title="沒有等待合併的 PR"
                    >
                      修改通過驗證並建立 PR 後，你就能在這裡開啟 PR。
                    </Empty>
                  )}
                </div>
              </section>
            </>
          )}
          <div className="flex flex-wrap items-center gap-x-4 border-t pt-2 text-sm text-muted-foreground">
            <button
              type="button"
              className="work-touch font-medium hover:underline"
              onClick={() => showTasks("closed")}
            >
              近 7 天已合併 <span className="tabular-nums">{mergedWeek}</span>
            </button>
            <span className="tabular-nums">
              累計 {state.totals?.tasks ?? state.tasks.length} 個需求
            </span>
          </div>
        </div>
        <ActivityFeed state={state} open={open} more={more} />
      </div>
    </div>
  );
}

const batchFocus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const batchControl = cn(
  batchFocus,
  "h-auto min-h-11 max-w-full whitespace-normal motion-reduce:transition-none aria-disabled:opacity-50",
);
const batchCheckbox = cn(batchFocus, "size-5 shrink-0 accent-primary");

function TaskSectionTitle({
  id,
  count,
  open,
  subdued = false,
  children,
}: {
  id: string;
  count: number;
  open: () => void;
  subdued?: boolean;
  children: string;
}) {
  return (
    <h2
      id={id}
      className={
        subdued
          ? "text-sm font-medium text-muted-foreground"
          : "text-lg font-semibold"
      }
    >
      <button
        type="button"
        onClick={open}
        className={cn(
          "work-touch inline-flex items-center gap-2 text-left hover:underline",
          !subdued && "pb-2",
        )}
      >
        {children}{" "}
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </button>
    </h2>
  );
}

// 動態依種類給圖示與色調；技術細節留在系統紀錄。
const activityKinds: Record<string, { icon: typeof Activity; tone: string }> = {
  ready: { icon: GitPullRequest, tone: "text-good" },
  answered: { icon: MessageSquareText, tone: "text-good" },
  merged: { icon: GitMerge, tone: "text-good" },
  approve: { icon: Check, tone: "text-muted-foreground" },
  adopt: { icon: Check, tone: "text-muted-foreground" },
  started: { icon: Play, tone: "text-muted-foreground" },
  attempt: { icon: Bot, tone: "text-muted-foreground" },
  verification: { icon: ScanSearch, tone: "text-muted-foreground" },
  triage: { icon: FileSearch, tone: "text-muted-foreground" },
  triage_skipped: { icon: FileSearch, tone: "text-muted-foreground" },
  retrieval: { icon: FileSearch, tone: "text-muted-foreground" },
  error: { icon: CircleAlert, tone: "text-danger" },
  retry: { icon: RefreshCw, tone: "text-warn" },
  settings: { icon: Settings2, tone: "text-muted-foreground" },
  backup: { icon: Archive, tone: "text-muted-foreground" },
  recovery: { icon: RotateCcw, tone: "text-muted-foreground" },
};
const activityClock = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dayLabel(value: string) {
  const day = activityDay(value);
  const today = new Date();
  if (day === activityDay(today)) return "今天";
  if (day === activityDay(new Date(today.getTime() - 86400000))) return "昨天";
  return new Date(value).toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
}

function ActivityTime({ value }: { value: string }) {
  return (
    <time
      dateTime={value}
      className="text-xs tabular-nums text-muted-foreground"
    >
      {activityClock.format(new Date(value))}
    </time>
  );
}

function ActivityRow({
  group,
  open,
}: {
  group: ActivityGroup;
  open: (id: string) => unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const { latest, steps } = group;
  const taskId = latest.task_id;
  const title = latest.task_title ?? "查看任務";
  const detail = activityDetail(latest);
  const status = taskId ? activityStatus(latest) : detail;
  const canExpand = !!taskId && (steps.length > 1 || status !== detail);
  const times = steps.find(({ event }) => event === latest)?.times ?? 1;
  return (
    <div className="min-w-0 flex-1 pb-3 text-sm [overflow-wrap:anywhere]">
      {taskId && (
        <button
          type="button"
          className={cn(
            "work-touch block max-w-full text-left font-medium hover:underline",
            batchFocus,
          )}
          onClick={() => open(taskId)}
        >
          {title}
        </button>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!taskId && (
          <span className="min-w-0 basis-full whitespace-pre-wrap">
            <Linkified text={detail} />
          </span>
        )}
        {taskId && <span>{status}</span>}
        <ActivityTime value={latest.created_at} />
        {times > 1 && (
          <span className="text-xs text-muted-foreground">共 {times} 次</span>
        )}
        {canExpand && (
          <button
            type="button"
            className={cn(
              "work-touch text-xs underline underline-offset-4",
              batchFocus,
            )}
            aria-label={`${expanded ? "收合步驟" : "展開步驟"}（${title}）`}
            aria-expanded={expanded}
            aria-controls={stepsId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收合步驟" : "展開步驟"}
          </button>
        )}
      </div>
      {canExpand && (
        <div id={stepsId} hidden={!expanded}>
          {expanded && (
            <ol aria-label="任務步驟" className="space-y-2 border-l py-1 pl-3">
              {steps.map(({ event, times }) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                >
                  <ActivityTime value={event.created_at} />
                  <span className="min-w-0 whitespace-pre-wrap">
                    <Linkified text={activityDetail(event)} />
                  </span>
                  {times > 1 && (
                    <span className="text-xs text-muted-foreground">
                      共 {times} 次
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

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
  const rows = groupActivity(state.activity, all);
  const items = rows.slice(0, limit);
  return (
    <section aria-label="最近動態" className="min-w-0">
      <SectionTitle
        action={
          <Button
            variant="ghost"
            size="xs"
            className={cn("text-muted-foreground", batchFocus)}
            aria-controls="inbox-activity"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "隱藏系統紀錄" : "顯示系統紀錄"}
          </Button>
        }
      >
        最近動態
      </SectionTitle>
      <Card className="py-4">
        <CardContent id="inbox-activity">
          {items.length ? (
            <ol className="flex flex-col">
              {items.map((group, i) => {
                const k = activityKinds[group.latest.kind] ?? {
                  icon: Activity,
                  tone: "text-muted-foreground",
                };
                const Icon = k.icon;
                return (
                  <li key={group.key} className="flex min-w-0 flex-col">
                    {group.day !== items[i - 1]?.day && (
                      <span
                        className={cn(
                          "pb-2 text-xs font-medium text-muted-foreground",
                          i > 0 && "pt-2",
                        )}
                      >
                        {dayLabel(group.latest.created_at)}
                      </span>
                    )}
                    <div className="flex gap-3">
                      <span
                        aria-hidden="true"
                        className="flex flex-col items-center"
                      >
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
                      <ActivityRow group={group} open={open} />
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
            </ol>
          ) : (
            <Empty compact icon={<Activity />} title="這裡還沒有可顯示的動態">
              {(state.totals?.activity ?? 0) > state.activity.length
                ? "你可以載入更早的紀錄來查看任務進度。"
                : !all && state.activity.length > 0
                  ? "你目前只有系統紀錄，可以按「顯示系統紀錄」查看。"
                  : "你可以在群組提出需求，任務有進展時就會出現在這裡。"}
            </Empty>
          )}
          {rows.length <= limit && (
            <LoadMore
              shown={state.activity.length}
              total={state.totals?.activity}
              unit="筆紀錄"
              more={async () => {
                await more();
                setLimit((n) => n + 20);
              }}
            />
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
  selection,
}: {
  task: Task;
  state: State;
  busy: boolean;
  open: (id: string, amend?: boolean) => unknown;
  act: Act;
  go?: (v: View, projectId?: string | null) => void;
  selection?: React.ReactNode;
}) {
  const pick = t.status === "awaiting_approval" && !t.project_id;
  // 失敗說明拆成白話說明、建議與錯誤重點：建議固定排在最後，整段截兩行一定看不到。
  const failure = t.status === "failed" ? parseFailure(t.last_error) : null;
  // 主動作與任務詳情共用 primaryFix：重試、縮小需求範圍、前往頁面或看詳情。
  const fix = primaryFix(failure);
  // go 只在管理者時提供；成員看不到前往設定頁的按鈕，改用「詳情」當主按鈕。
  const target = go && fix.kind === "page" ? fix.page : null;
  const amend = t.status === "failed" && fix.kind === "amend";
  const reason =
    t.status === "awaiting_approval"
      ? pick
        ? "請選擇這次需求要處理的專案。"
        : (t.risk_reasons[0] ?? t.missing[0] ?? "需求等待確認")
      : failure
        ? failure.headline
        : (t.last_error?.replace(/^Error: /, "") ?? statusLabels[t.status]);
  return (
    <div className="py-4">
      <CardContent>
        <div className="grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,30%)]">
          <div className="flex min-w-0 items-start gap-1">
            {selection}
            <button
              className="work-touch flex min-w-0 w-full flex-col gap-1 text-left"
              onClick={() => open(t.id)}
            >
              <span className="text-lg font-semibold [overflow-wrap:anywhere]">
                {taskListTitle(t)}
              </span>
              <TaskRowFields task={t} state={state} />
              <span
                className={cn(
                  "flex items-start gap-1.5 text-sm",
                  t.status === "failed" ? "text-danger" : "text-warn",
                )}
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="line-clamp-2 [overflow-wrap:anywhere]">
                  {reason}
                </span>
              </span>
            </button>
          </div>
          <StationTrack task={t} />
        </div>
        {failure && (
          <div className="mt-1.5 flex flex-col gap-1.5 pl-[1.375rem] text-sm">
            <p className="font-medium [overflow-wrap:anywhere]">
              建議：{failure.action}
            </p>
            {failure.detail && (
              <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                <span className="font-medium">錯誤重點</span>
                <Clamped text={failure.detail} lines={2} />
              </div>
            )}
          </div>
        )}
        {pick ? (
          <AssignProject
            task={t}
            state={state}
            busy={busy}
            act={act}
            go={go}
            open={() => open(t.id)}
            onBound={() => open(t.id)}
          />
        ) : (
          <>
            {t.status === "awaiting_approval" && t.suggestions.length > 0 && (
              <SuggestionList task={t} busy={busy} open={() => open(t.id)} />
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {t.status === "awaiting_approval" && !t.missing.length && (
                <Button disabled={busy} onClick={() => open(t.id)}>
                  <Check /> 檢視專案並確認
                </Button>
              )}
              {t.status === "awaiting_approval" && t.missing.length > 0 && (
                <Button
                  variant={t.suggestions.length ? "outline" : "default"}
                  onClick={() => open(t.id, true)}
                >
                  修改這一題
                </Button>
              )}
              {/* 失敗時主按鈕依原因：先修設定的前往頁面、逾時先修改這一題；
                  這兩種重試只會再失敗一次、多用一次額度，所以重試降為次要。 */}
              {target && go && (
                <Button onClick={() => go(target, t.project_id)}>
                  {fixPageLabels[target]}
                </Button>
              )}
              {amend && (
                <Button onClick={() => open(t.id, true)}>修改這一題</Button>
              )}
              {t.status === "failed" && (
                <Button
                  variant={fix.kind === "retry" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void act(t, "retry", {}, "已重新排程")}
                >
                  <RefreshCw /> 重試
                </Button>
              )}
              <EndTaskButton task={t} busy={busy} act={act} />
              <Button
                variant={fix.kind === "detail" ? "default" : "ghost"}
                onClick={() => open(t.id)}
              >
                詳情
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </div>
  );
}

/**
 * 等待額度時的次要按鈕只在 API 模式顯示，因為管理者可能剛提高預算。
 * 訂閱模式在額度恢復或保留比例調低至額度可用後由排程自動重試。
 */
export function BudgetRetry({
  task: t,
  state,
  busy,
  act,
}: {
  task: Task;
  state: State;
  busy: boolean;
  act: Act;
}) {
  if (t.status !== "budget_wait" || state.settings.ai_mode !== "api")
    return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() =>
        void act(t, "retry", {}, "已重新排程；額度仍不足時會回到等待額度")
      }
    >
      <RefreshCw /> 已提高預算，立即再試
    </Button>
  );
}

// 等待額度的一列：保留原因、什麼時候自動繼續，沒有「重試」主按鈕。
function WaitingRow({
  task: t,
  state,
  busy,
  open,
  act,
}: {
  task: Task;
  state: State;
  busy: boolean;
  open: (id: string) => unknown;
  act: Act;
}) {
  const reason = t.last_error?.replace(/^Error: /, "");
  const hint = waitHint(t.last_error, state.settings.ai_mode);
  return (
    <div className="work-row">
      <button
        className="work-touch flex min-w-0 flex-col gap-1 text-left"
        onClick={() => open(t.id)}
      >
        <span className="font-medium [overflow-wrap:anywhere]">
          {taskListTitle(t)}
        </span>
        <TaskRowFields task={t} state={state} />
        {reason && (
          <span className="text-sm text-warn [overflow-wrap:anywhere]">
            {reason}
          </span>
        )}
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </button>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <StationTrack task={t} />
        <BudgetRetry task={t} state={state} busy={busy} act={act} />
      </div>
    </div>
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
          <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
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
  sources,
  open,
  onBound,
}: {
  task: Task;
  state: State;
  busy: boolean;
  act: Act;
  // 只有管理者能去群組與專案頁；沒給就只說明原因。
  go?: (v: View, projectId?: string | null) => void;
  sources?: { id: string; text: string | null }[];
  open?: () => unknown;
  onBound?: () => unknown;
}) {
  const group = state.groups.find((g) => g.id === t.group_id);
  const bound = state.projects.filter((p) => group?.project_ids.includes(p.id));
  // 找不到儲存庫、還沒驗證或已停用的專案派不了工：列出來讓人知道原因，但不能選。
  const blocked = (p: Project) =>
    p.repo_missing_at
      ? projectLabels.missing
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
  const suggestions = (
    !t.project_id ? (t.project_routing?.unboundSuggestions ?? []) : []
  ).flatMap((suggestion) => {
    const project = state.projects.find((p) => p.id === suggestion.projectId);
    return project &&
      !blocked(project) &&
      project.config_version === suggestion.configVersion &&
      !bound.some((p) => p.id === project.id)
      ? [{ suggestion, project }]
      : [];
  });
  return (
    <div className="mt-4 flex flex-col gap-3">
      {suggestions.length > 0 && (
        <ul className="space-y-4">
          {suggestions.map(({ suggestion, project }) => {
            const cited =
              sources?.filter(
                (m) => m.text && suggestion.sourceIds.includes(m.id),
              ) ?? [];
            return (
              <li
                key={project.id}
                className="min-w-0 space-y-1 [overflow-wrap:anywhere]"
              >
                <p className="font-semibold">
                  看起來是 {project.name}（尚未綁定這個群組）
                </p>
                <p className="text-sm text-muted-foreground">
                  {suggestion.reason}
                </p>
                {cited.length > 0 && (
                  <details className="text-sm">
                    <summary className="flex min-h-11 cursor-pointer items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                      查看引用訊息
                    </summary>
                    {cited.map((m) => (
                      <blockquote
                        key={m.id}
                        className="mb-2 border-l-2 pl-3 whitespace-pre-wrap"
                      >
                        {m.text}
                      </blockquote>
                    ))}
                  </details>
                )}
                {go ? (
                  <Button
                    type="button"
                    variant={suggestions.length === 1 ? "default" : "outline"}
                    className="h-auto min-h-11 max-w-full whitespace-normal border-muted-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground dark:border-muted-foreground"
                    disabled={busy}
                    aria-label={`綁定並指定這個專案（${project.name}）`}
                    onClick={async () => {
                      const assigned = await act(
                        t,
                        "bind_assign",
                        { project_id: project.id },
                        "已綁定並指定專案",
                      );
                      if (assigned) onBound?.();
                    }}
                  >
                    綁定並指定這個專案
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    你可以請管理者綁定並指定這個專案。
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && suggestions.length > 0 && (
        <Button
          type="button"
          variant="link"
          className="min-h-11 self-start px-0 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          onClick={open}
        >
          查看引用訊息
        </Button>
      )}
      <span className="text-sm font-medium">
        {suggestions.length
          ? "你也可以選擇已綁定的專案。"
          : "這次需求要處理哪個專案？"}
      </span>
      <div className="flex flex-wrap gap-2">
        {bound.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={
              pick === p.id && !suggestions.length ? "default" : "outline"
            }
            aria-pressed={pick === p.id}
            className={
              suggestions.length
                ? "h-auto min-h-11 max-w-full motion-reduce:transition-none"
                : undefined
            }
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
              onClick={() =>
                go(
                  bound.length ? "projects" : "groups",
                  bound.length === 1 ? bound[0].id : null,
                )
              }
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
          variant={suggestions.length ? "outline" : "default"}
          className={
            suggestions.length
              ? "min-h-11 motion-reduce:transition-none"
              : undefined
          }
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
        <EndTaskButton task={t} busy={busy} act={act} />
      </div>
    </div>
  );
}

export function EndTaskButton({
  task: t,
  busy,
  act,
}: {
  task: Task;
  busy: boolean;
  act: Act;
}) {
  const label = ["running", "reviewing"].includes(t.status)
    ? "停止並結束"
    : "結束任務";
  return (
    <ConfirmButton
      variant="outline"
      disabled={busy}
      title={label + "？"}
      description="結束後不會派工，你之後可在任務詳情按「重新開啟」。"
      confirm={label}
      onConfirm={() =>
        act(
          t,
          t.status === "awaiting_approval" ? "reject" : "cancel",
          {},
          "已結束任務",
        )
      }
    >
      {label}
    </ConfirmButton>
  );
}

function TaskRowFields({
  task,
  state,
  hide,
}: {
  task: Task;
  state: State;
  hide?: "project" | "group" | "none";
}) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <span>{task.mode === "query" ? "查詢" : "修改"}</span>
      {hide !== "group" && <span>群組 {groupName(state, task)}</span>}
      {hide !== "project" && <span>專案 {projectName(state, task)}</span>}
      {task.issue_number && (
        <span className="tabular-nums">Issue #{task.issue_number}</span>
      )}
      <span className="tabular-nums">更新於 {ago(task.updated_at)}</span>
    </span>
  );
}

export function TaskRow({
  task: t,
  state,
  open,
  hide,
  trailing,
}: {
  task: Task;
  state: State;
  open: (id: string) => unknown;
  hide?: "project" | "group" | "none";
  trailing?: React.ReactNode;
}) {
  const why = t.status === "failed" ? failureBrief(t.last_error) : "";
  const held = t.status === "queued" && !!memoryHold(state);
  const description = (
    <span className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
      <span className="font-semibold">{taskListTitle(t)}</span>
      <TaskRowFields task={t} state={state} hide={hide} />
      {why && <span className="text-sm text-danger">{why}</span>}
      {held && (
        <span className="text-sm text-warn">派工暫停，恢復後會自動繼續。</span>
      )}
      {["running", "reviewing"].includes(t.status) && t.run_phase && (
        <RunProgressLine
          run={{
            phase: t.run_phase,
            startedAt: t.run_started_at,
            deadline: t.run_deadline,
            heartbeatAt: t.run_heartbeat_at,
          }}
        />
      )}
    </span>
  );
  if (trailing) {
    return (
      <div className="work-row">
        <button
          className="work-touch min-w-0 text-left hover:underline"
          onClick={() => open(t.id)}
        >
          {description}
        </button>
        <div className="flex min-w-0 flex-col items-start gap-2">
          <StationTrack task={t} />
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <button className="work-row" data-task-id={t.id} onClick={() => open(t.id)}>
      {description}
      <StationTrack task={t} />
    </button>
  );
}
