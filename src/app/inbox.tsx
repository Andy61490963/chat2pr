import {
  groupPlatformLabels,
  inboxStatusLabels,
  taskListLabels,
  taskStatusFilterLabels,
  type EndReason,
} from "../../shared/status-glossary.js";
import {
  isMergedInWeek,
  mergedWeekBounds,
  mergedWeekDay,
  type TaskListDestination,
} from "../../shared/task-list.js";
import { taskListTitle } from "../../shared/task-title.js";
import { firstSetupStatus } from "../../shared/first-setup.js";
import { reviewItems, type ReviewSort } from "../../shared/review-queue.js";
import {
  activityDay,
  activityDetail,
  activityStatus,
  groupActivity,
  type ActivityGroup,
} from "../../shared/activity-groups.js";
import { useEffect, useId, useRef, useState } from "react";
import type { PickList } from "../../shared/pick-list.js";
import { ReviewWorkbench, type ReviewActions } from "./review-workbench";
import { ReviewKeyboardHint } from "./review-queue-list";
import { BudgetRetry, EndReasonFields } from "./task-actions";
import { useGuard } from "./unsaved";
import {
  Activity,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
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
  type Task,
} from "../../shared/types.js";
import { failureBrief, waitHint } from "../../shared/failure-text.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/form-controls";
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
import {
  type Act,
  type State,
  type View,
  ago,
  type Detail,
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
  const status = firstSetupStatus(state);
  const platformNames = status.platforms.map((p) => groupPlatformLabels[p]);
  const subscription = state.settings.ai_mode !== "api";
  const required = [
    {
      done: status.services,
      label: "服務連線正常",
      hint: "在設定頁按「檢查連線」",
      view: "settings",
    },
    {
      done: status.chat,
      label: platformNames.length
        ? `${platformNames.join("或")}收件連線正常`
        : "至少接通一個收件平台",
      hint: platformNames.length
        ? "在設定頁檢查群組使用的聊天平台連線"
        : "在設定頁接通 LINE 或 Discord",
      view: "settings",
    },
    {
      done: status.ai,
      label: subscription ? "服務的 Codex 已登入訂閱" : "OpenAI API 可用",
      hint: subscription
        ? "在主機執行 npm run codex:login，再檢查連線"
        : "在本機設定頁填入 API 金鑰",
      view: "settings",
    },
    {
      done: status.project,
      label: "至少一個專案通過驗證並啟用",
      hint: "新增專案、驗證環境並啟用",
      view: "projects",
    },
    {
      done: status.route,
      label: "群組已綁定可派工的專案",
      hint: "在群組頁勾選可派工的專案，並允許群組提出需求",
      view: "groups",
    },
    {
      done: status.dispatch,
      label: "開始自動派工",
      hint: "右上角切換",
      view: "inbox",
    },
  ] as const;
  const optional = [
    {
      done: status.notifications,
      label: "管理者私訊通知已配對",
      hint: "在設定頁產生配對碼",
      view: "settings",
    },
  ] as const;
  return { required, optional };
}

type OpenTask = (id: string) => unknown;

export function InboxReadState({ error, retry }: { error: string; retry: () => Promise<boolean> }) {
  const [retrying, setRetrying] = useState(false);
  const networkError = /^TypeError: (Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(error);
  return (
    <Card>
      <CardContent className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
          {error
            ? <CircleAlert className="size-5 text-danger" />
            : <Loader2 className="size-5 motion-safe:animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <div role={error ? "alert" : "status"}>
            <h2 className="font-semibold">{error ? "收件匣未能載入" : "正在讀取收件匣"}</h2>
            <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {networkError ? "連不上服務，請確認網路連線後重試。" : error || "正在取得待決策的任務與最近動態。"}
            </p>
          </div>
          {error && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              aria-disabled={retrying}
              onClick={async () => {
                if (retrying) return;
                setRetrying(true);
                try {
                  await retry();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "正在重試" : "重試"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
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
  reviewId,
  setReview,
  reviewSuspended,
  reviewError,
  reviewActions,
  loadTaskDetail,
  more,
}: {
  state: State;
  needs: Task[];
  busy: boolean;
  go: (v: View, projectId?: string | null) => void;
  admin: boolean;
  showTasks: (filter: TaskListDestination) => void;
  open: OpenTask;
  act: Act;
  endTasks: (
    tasks: EndTaskSelection[],
    choice: { end_reason?: EndReason; reason: string },
    notify: boolean,
  ) => Promise<boolean>;
  resolvePickList: (list: PickList, ids: string[]) => Promise<boolean>;
  reviewId: string | null;
  setReview: (id: string | null, push?: boolean) => void;
  reviewSuspended: boolean;
  reviewError?: string;
  reviewActions: ReviewActions;
  loadTaskDetail: (id: string) => Promise<Detail>;
  more: () => unknown;
}) {
  const [tab, setTab] = useState("decisions");
  const [sort, setSort] = useState<ReviewSort>("oldest");
  const activeTab = reviewId ? "decisions" : tab;
  const guard = useGuard();
  const [selected, setSelected] = useState(new Map<string, EndTaskSelection>());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [missingReason, setMissingReason] = useState(false);
  const firstReason = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const decisionSection = useRef<HTMLElement>(null);
  const stuckHeading = useRef<HTMLHeadingElement>(null);
  const categoryList = useRef<HTMLDivElement>(null);
  const [moreCategories, setMoreCategories] = useState(false);
  useEffect(() => {
    const list = categoryList.current;
    if (!list) return;
    const measure = () => setMoreCategories(list.scrollWidth - list.clientWidth - list.scrollLeft > 1);
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    for (const tab of list.children) resize.observe(tab);
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      resize.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, []);
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
  // 選取裡有待審核的任務就是拒絕：要選原因，判讀才能少建立同類任務。
  const rejecting = [...selected.values()].some(
    (task) => task.status === "awaiting_approval",
  );
  const submitEnd = async () => {
    if (rejecting && !endReason) {
      setMissingReason(true);
      firstReason.current?.focus();
      return;
    }
    setConfirmEnd(false);
    if (
      !(await endTasks(
        [...selected.values()],
        { end_reason: endReason ?? undefined, reason: reason.trim() },
        notify,
      ))
    )
      return;
    if (
      document.activeElement === endButton.current ||
      document.activeElement === document.body
    )
      decisionSection.current?.focus();
    setSelected(new Map());
    setEndReason(null);
    setMissingReason(false);
    setReason("");
    setNotify(true);
  };
  const setup = setupSteps(state);
  const left = setup.required.filter((s) => !s.done);
  const groups = [
    { title: "必須設定", steps: left },
    { title: "選配", steps: setup.optional.filter((s) => !s.done) },
  ];
  // 清單用已載入的任務（未結束的伺服器一律載入）；摘要的數字用伺服器的實際數量。
  const working = state.tasks.filter((t) => moving.includes(t.status));
  const ready = state.tasks.filter((t) => readyStatuses.includes(t.status));
  const held = state.tasks.filter((t) => waitingStatuses.includes(t.status));
  const movingCount = countOf(state, moving);
  const readyCount = countOf(state, readyStatuses);
  const stuckTasks = state.stuckTasks ?? [];
  const stuckTasksTotal = state.stuckTasksTotal ?? stuckTasks.length;
  const lists = admin ? (state.pickLists ?? []) : [];
  const items = reviewItems(needs, lists, state.groups, admin);
  const canBatch = admin && items.length > 1;
  const clear =
    items.length === 0 &&
    movingCount === 0 &&
    readyCount === 0 &&
    working.length === 0 &&
    ready.length === 0;
  const weekDay = state.totals?.mergedWeekDay ?? mergedWeekDay();
  const week = mergedWeekBounds(weekDay)!;
  const mergedWeek =
    state.totals?.mergedWeek ??
    state.tasks.filter((t) => isMergedInWeek(t, week)).length;
  const categories = [
    { value: "decisions", label: "決定", count: items.length },
    { value: "moving", label: taskStatusFilterLabels.moving, count: movingCount },
    { value: "ready", label: statusLabels.ready, count: readyCount },
    { value: "activity", label: "動態", count: state.totals?.activity ?? state.activity.length },
  ];
  const batchControls =
    canBatch && selected.size > 0 && (
      <div role="group" aria-label="批次操作" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
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
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            setSelected(new Map());
            decisionSection.current
              ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
              ?.focus({ preventScroll: true });
          }}
        >
          清除選取
        </Button>
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
      </div>
    );
  const onboarding = left.length > 0 && (
    <Card className="gap-3">
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">開始使用</h2>
          <span className="text-sm text-muted-foreground">
            必須設定已完成 {setup.required.length - left.length} / {setup.required.length}
          </span>
        </div>
        <div className="grid gap-4">
          {groups.map(({ title, steps }) => steps.length > 0 && (
            <div key={title} className="grid gap-2">
              <h3 className="text-sm font-medium">{title}</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {steps.map((s) => (
                  <li
                    key={s.label}
                    className="flex items-start gap-3 rounded-lg bg-muted/60 px-3 py-2.5"
                  >
                    <Circle className="mt-0.5 size-4 shrink-0 text-warn" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.hint}</span>
                    </span>
                    {/* 成員沒有管理頁權限。 */}
                    {admin && s.view !== "inbox" && (
                      <Button variant="link" size="sm" className="min-h-11 shrink-0 md:min-h-8" onClick={() => go(s.view)}>
                        前往 <span className="sr-only">設定：{s.label}</span>
                        <ChevronRight />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
  return (
    <Tabs
      value={activeTab}
      activationMode="manual"
      onValueChange={(next) => {
        setTimeout(() => guard(() => {
          setTab(next);
          if (reviewId && next !== "decisions") setReview(null);
        }, { prefixes: ["task"] }), 0);
      }}
      className="work-surface min-w-0 gap-3 md:gap-4"
    >
      <div className="flex min-w-0 flex-col border-b sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <TabsList ref={categoryList} aria-label="收件匣分類" className={cn("h-auto max-w-full flex-none justify-start gap-2 overflow-x-auto rounded-none bg-transparent p-0 sm:gap-0", moreCategories && "max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-12px),transparent)]")}>
          {categories.map(({ value, label, count }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="min-h-11 min-w-11 flex-none gap-1.5 rounded-none border-0 border-b-2 border-transparent px-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none sm:px-3 sm:text-sm dark:data-[state=active]:border-primary"
            >
              {label}{" "}<span className="rounded text-xs tabular-nums sm:bg-muted sm:px-1">{count}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {activeTab === "decisions" && (items.length > 0 || stuckTasks.length > 0) && (
          <div className="flex max-w-full items-center justify-between gap-x-2 sm:ml-auto sm:flex-wrap sm:justify-end sm:gap-x-3">
            {items.length > 0 && <ReviewKeyboardHint />}
            {stuckTasks.length > 0 && (
              <button
                type="button"
                title={`卡住的任務 ${stuckTasksTotal}`}
                className={cn("inline-flex min-h-11 min-w-11 items-center justify-center gap-1 whitespace-nowrap rounded-sm text-xs font-medium hover:underline", batchFocus)}
                onClick={() => stuckHeading.current?.focus()}
              >
                <CircleAlert aria-hidden="true" className="hidden size-3.5 text-warn sm:block" />
                <span>卡住的任務</span>{" "}
                <span className="tabular-nums">{stuckTasksTotal}</span>
              </button>
            )}
            {items.length > 0 && (
              <select
                aria-label="待決策排序"
                className={cn("ml-auto min-h-11 min-w-11 rounded-md border border-input bg-background px-1.5 text-xs text-foreground sm:ml-0 lg:pointer-fine:min-h-8 [@media(any-pointer:coarse)]:min-h-11!", batchFocus)}
                value={sort}
                onChange={(event) => setSort(event.target.value === "newest" ? "newest" : "oldest")}
              >
                <option value="oldest">等最久</option>
                <option value="newest">最新</option>
              </select>
            )}
          </div>
        )}
      </div>
      {!items.length && !stuckTasks.length && onboarding}
      <TabsContent value="decisions" className="grid min-w-0 gap-3 md:gap-4">
      <section
        ref={decisionSection}
        tabIndex={-1}
        aria-label="待決策佇列"
        className={batchFocus}
      >
        {activeTab === "decisions" && (!stuckTasks.length || items.length > 0 || confirmEnd) && <ReviewWorkbench
          items={items}
          sort={sort}
          lists={lists}
          reviewId={reviewId}
          setReview={setReview}
          state={state}
          admin={admin}
          busy={busy}
          suspended={reviewSuspended}
          actionError={reviewError}
          loadTaskDetail={loadTaskDetail}
          actions={reviewActions}
          resolvePickList={resolvePickList}
          empty={
            !items.length ? (
              <Card className="flex-row items-center gap-4 px-5 py-5">
                <span
                  aria-hidden
                  className="grid size-10 shrink-0 place-items-center shape-pill bg-muted text-muted-foreground"
                >
                  <CircleCheck className="size-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="font-semibold">
                    {inboxStatusLabels.clear}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {clear ? inboxStatusLabels.clearDescription : "其餘工作可到進行中或待合併查看。"}
                  </p>
                </div>
              </Card>
            ) : undefined
          }
          batchControls={batchControls}
          checkbox={(item) =>
            canBatch && item.kind === "task" && eligible.has(item.id) ? (
              <label className="grid size-11 shrink-0 cursor-pointer self-center place-items-center rounded-md">
                <input
                  type="checkbox"
                  className={batchCheckbox}
                  checked={selected.has(item.id)}
                  disabled={busy}
                  onChange={(event) =>
                    toggleTask(item.id, event.target.checked)
                  }
                />
                <span className="sr-only">選取「{item.title}」</span>
              </label>
            ) : undefined
          }
        />}
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
              <EndReasonFields
                value={endReason}
                onChange={(value) => {
                  setEndReason(value);
                  setMissingReason(false);
                }}
                note={reason}
                onNote={setReason}
                error={missingReason}
                firstRef={firstReason}
              />
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
      {stuckTasks.length > 0 && (
        <section aria-labelledby="inbox-stuck" className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4 text-warn" />
            <h2 ref={stuckHeading} id="inbox-stuck" tabIndex={-1} className={cn("scroll-mt-4 font-semibold", batchFocus)}>
              卡住的任務
            </h2>
            <Badge variant="secondary" className="tabular-nums">{stuckTasksTotal}</Badge>
          </div>
          {stuckTasksTotal > stuckTasks.length && (
            <p className="text-sm text-muted-foreground">依卡住時間先後，顯示前 {stuckTasks.length} 筆。</p>
          )}
          <ul className="work-ledger divide-y">
            {stuckTasks.map(({ taskId, title, reason, actionLabel, target }) => {
              const needsAdmin = target === "system" && !admin;
              return (
                <li key={taskId} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="grid min-w-0 gap-1 [overflow-wrap:anywhere]">
                    <span className="font-semibold">{title}</span>
                    <p className="text-sm text-muted-foreground">{reason}</p>
                    {needsAdmin && <p className="text-sm">請管理者查看系統。</p>}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(batchControl, "justify-self-start md:min-h-8")}
                    onClick={() => target === "system" && admin ? go("system") : open(taskId)}
                  >
                    {needsAdmin ? "查看任務" : actionLabel}
                    <span className="sr-only">：{title}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Button variant="link" className="justify-self-start" onClick={() => showTasks("todo")}>
        查看需要你處理的任務
      </Button>
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
      </TabsContent>
      <TabsContent value="moving">
        <TaskSectionTitle id="inbox-moving" open={() => showTasks("moving")}>{taskStatusFilterLabels.moving}</TaskSectionTitle>
        <div className="work-ledger mt-1">
          {working.length ? working.map((entry) => (
            <TaskRow key={entry.id} task={entry} state={state} open={open} />
          )) : (
            <Empty compact icon={<Loader2 />} title="目前沒有執行中的工作">
              你核准需求後，就能在這裡追蹤進度。
            </Empty>
          )}
        </div>
      </TabsContent>
      <TabsContent value="ready">
        <TaskSectionTitle id="inbox-ready" open={() => showTasks("ready")}>{statusLabels.ready}</TaskSectionTitle>
        <div className="work-ledger mt-1">
          {ready.length ? ready.map((entry) => (
            <TaskRow
              key={entry.id}
              task={entry}
              state={state}
              open={open}
              trailing={entry.pr_url && (
                <Button variant="outline" size="sm" asChild>
                  <a href={entry.pr_url} target="_blank" rel="noreferrer">
                    PR #{entry.pr_number} <ArrowUpRight />
                  </a>
                </Button>
              )}
            />
          )) : (
            <Empty compact icon={<GitPullRequest />} title="沒有等待合併的 PR">
              修改通過驗證並建立 PR 後，你就能在這裡開啟 PR。
            </Empty>
          )}
        </div>
      </TabsContent>
      <TabsContent value="activity">
        <ActivityFeed state={state} open={open} more={more} />
      </TabsContent>
      {(items.length > 0 || stuckTasks.length > 0) && onboarding}
      <div className="flex flex-wrap items-center gap-x-4 border-t pt-1 text-sm text-muted-foreground">
        <button
          type="button"
          className="work-touch font-medium hover:underline"
          onClick={() => showTasks({ mergedWeek: weekDay })}
        >
          {taskListLabels.mergedWeek}{" "}
          <span className="tabular-nums">{mergedWeek}</span>
        </button>
        <span className="tabular-nums">
          累計 {state.totals?.tasks ?? state.tasks.length} 個需求
        </span>
      </div>
    </Tabs>
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
  count?: number;
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
          : "heading-section"
      }
    >
      <button
        type="button"
        onClick={open}
        className={cn(
          "work-touch inline-flex items-center gap-2 rounded-sm text-left hover:underline",
          batchFocus,
        )}
      >
        {children}{" "}
        {count !== undefined && <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>}
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
    </h2>
  );
}

// 動態依種類給圖示與色調；技術細節留在系統紀錄。
const activityKinds: Record<string, { icon: typeof Activity; tone: string }> = {
  ready: { icon: GitPullRequest, tone: "text-muted-foreground" },
  answered: { icon: MessageSquareText, tone: "text-muted-foreground" },
  merged: { icon: GitMerge, tone: "text-muted-foreground" },
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
    <div className="min-w-0 flex-1 pb-2 text-sm [overflow-wrap:anywhere]">
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
  const [extra, setExtra] = useState(0);
  const limit = 10 + extra;
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
      <Card className="py-3">
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
                    onClick={() => setExtra((previous) => previous + 20)}
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
                setExtra((previous) => previous + 20);
              }}
            />
          )}
        </CardContent>
      </Card>
    </section>
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
