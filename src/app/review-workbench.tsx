import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { PickList } from "../../shared/pick-list.js";
import {
  nextReviewItem,
  pickListReviewId,
  sortReviewItems,
  type ReviewItem,
  type ReviewSort,
} from "../../shared/review-queue.js";
import { inboxStatusLabels } from "../../shared/status-glossary.js";
import { PickListForm } from "./pick-list";
import {
  matchesApproval, quickApproval, ReviewQueue, type QuickApproval, type SelectionMode,
} from "./review-queue-list";
import { Empty, message, type Detail, type State } from "./shared";
import {
  TaskReviewPanel,
  type TaskReviewPanelProps,
} from "./task-review-panel";
import { useGuard } from "./unsaved";

const desktopMedia = "(min-width: 64rem)";
const isDesktopWidth = () => window.matchMedia(desktopMedia).matches;
function subscribeToReviewLayout(onChange: () => void) {
  const query = window.matchMedia(desktopMedia);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}


export type ReviewActions = Pick<
  TaskReviewPanelProps,
  "act" | "answer" | "followup" | "go" | "open" | "relink" | "repairBaseline"
> & {
  verifyQuickActor: () => Promise<boolean>;
  approveFromQueue: (task: Detail["task"], body: QuickApproval["body"], onError: (text: string, updated?: Detail["task"]) => void) => Promise<boolean>;
};

type DetailResult = { id: string; detail?: Detail; error?: string };
type RowError = { text: string } & (Pick<Detail["task"], "version" | "updated_at"> | { awaitingUpdateFrom: State["tasks"] });

function readError(cause: unknown) {
  if (cause instanceof TypeError && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(cause.message))
    return navigator.onLine ? "未收到服務回應，請確認連線後再試。" : "裝置目前離線，請恢復網路連線後再試。";
  return message(cause);
}

export function ReviewWorkbench({
  items,
  sort,
  lists,
  reviewId,
  setReview,
  state,
  admin,
  busy,
  suspended,
  actionError,
  loadTaskDetail,
  actions,
  resolvePickList,
  batchControls,
  checkbox,
  empty,
}: {
  items: readonly ReviewItem[];
  sort: ReviewSort;
  lists: readonly PickList[];
  reviewId: string | null;
  setReview: (id: string | null, push?: boolean) => void;
  state: State;
  admin: boolean;
  busy: boolean;
  suspended: boolean;
  actionError?: string;
  loadTaskDetail: (id: string) => Promise<Detail>;
  actions: ReviewActions;
  resolvePickList: (list: PickList, ids: string[]) => Promise<boolean>;
  batchControls?: ReactNode;
  checkbox: (item: ReviewItem) => ReactNode;
  empty?: ReactNode;
}) {
  const desktop = useSyncExternalStore(subscribeToReviewLayout, isDesktopWidth);
  const guard = useGuard();
  const [checking, setChecking] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  let reconciled = rowErrors;
  for (const [id, failed] of Object.entries(rowErrors)) {
    const task = state.tasks.find((task) => task.id === id);
    if (!task || !items.some((item) => item.kind === "task" && item.id === id) ||
        ("version" in failed && (task.version !== failed.version || task.updated_at !== failed.updated_at))) {
      if (reconciled === rowErrors) reconciled = { ...rowErrors };
      delete reconciled[id];
    } else if ("awaitingUpdateFrom" in failed && failed.awaitingUpdateFrom !== state.tasks) {
      if (reconciled === rowErrors) reconciled = { ...rowErrors };
      reconciled[id] = { text: failed.text, version: task.version, updated_at: task.updated_at };
    }
  }
  if (reconciled !== rowErrors) setRowErrors(reconciled);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [actorChanged, setActorChanged] = useState(false);
  const [quickNotice, setQuickNotice] = useState<{ id: string; text: string } | null>(null);
  const [result, setResult] = useState<DetailResult | null>(null);
  const [reload, reloadDetail] = useState(0);
  const [actionDock, setActionDock] = useState<HTMLDivElement | null>(null);
  const sorted = sortReviewItems(items, sort);
  const item = items.find(({ id }) => id === reviewId);
  const taskId = item?.kind === "task" && !suspended ? item.id : null;
  const list =
    item?.kind === "pickList"
      ? lists.find(({ id }) => pickListReviewId(id) === item.id)
      : undefined;
  const detail = result?.id === taskId ? result.detail : undefined;
  const error = result?.id === taskId ? result.error : undefined;
  const latestId = useRef(reviewId);
  const sheetTitle = useRef<HTMLHeadingElement>(null);
  latestId.current = reviewId;
  const latest = useRef({ state, admin, busy, suspended, loadTaskDetail });
  latest.current = { state, admin, busy, suspended, loadTaskDetail };
  const activeCheck = useRef<symbol | null>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const focusId = useRef<string | null>(null);
  const keepScroll = useRef(false);
  const focusAfterRemoval = useRef<string | null>(null);
  const completing = useRef(false);
  const attachPrimary = useCallback((button: HTMLButtonElement | null) => {
    primary.current = button;
  }, []);

  useEffect(() => {
    if (!reviewId || item || busy || completing.current) return;
    const first = sortReviewItems(items, sort)[0];
    if (
      focusId.current === reviewId ||
      focusAfterRemoval.current === reviewId
    ) {
      focusId.current = first?.id ?? null;
      focusAfterRemoval.current = null;
      if (!first) requestAnimationFrame(() => workbench.current?.focus({ preventScroll: true }));
    }
    setReview(first?.id ?? null, false);
  }, [reviewId, item, busy, items, sort, setReview]);

  // 桌面右欄不留白：進收件匣時直接打開等最久的一筆（取代網址，不多一筆上一頁）；手機維持先看佇列。
  useEffect(() => {
    if (!desktop || reviewId || suspended || completing.current) return;
    const first = sortReviewItems(items, sort)[0];
    if (first) setReview(first.id, false);
  }, [desktop, reviewId, suspended, items, sort, setReview]);

  useEffect(() => {
    if (!taskId) {
      setResult(null);
      return;
    }
    let active = true;
    void loadTaskDetail(taskId).then(
      (detail) => {
        if (active) setResult({ id: taskId, detail });
      },
      (e) => {
        if (active)
          setResult((current) => ({
            id: taskId,
            detail: current?.id === taskId ? current.detail : undefined,
            error: readError(e),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [taskId, state, reload, loadTaskDetail]);

  const focusPanel = useCallback(() => {
    const root = panel.current;
    if (!root || !focusId.current || root.dataset.reviewId !== focusId.current)
      return;
    const target =
      primary.current?.isConnected && !primary.current.disabled
        ? primary.current
        : (root.querySelector<HTMLElement>("[data-task-project-choice]:enabled") ??
          root.querySelector<HTMLElement>(
            "[data-task-title], [data-review-error]",
          ));
    if (!target) return;
    target.focus({ preventScroll: keepScroll.current });
    keepScroll.current = false;
    focusId.current = null;
  }, []);
  useEffect(() => {
    if (!busy) focusPanel();
  }, [busy, desktop, item?.id, detail, error, focusPanel]);

  function focusQueue(id: string | null) {
    const row =
      id &&
      workbench.current?.querySelector<HTMLButtonElement>(
        `[data-review-row="${CSS.escape(id)}"]`,
      );
    if (row) row.focus();
    else workbench.current?.focus({ preventScroll: true });
  }

  function choose(id: string, mode: SelectionMode) {
    const select = () => {
      keepScroll.current = false;
      focusAfterRemoval.current = null;
      if (id !== reviewId) setQuickNotice(null);
      if (mode === "enter" || (!desktop && mode === "click"))
        focusId.current = id;
      else focusId.current = null;
      if (id !== reviewId) setReview(id);
      if (mode === "move") requestAnimationFrame(() => focusQueue(id));
      if (id === reviewId && mode === "enter") focusPanel();
    };
    if (id === reviewId) select();
    else guard(select, { prefixes: ["task"] });
  }

  const close = () =>
    guard(
      () => {
        focusId.current = null;
        setReview(null);
        requestAnimationFrame(() => focusQueue(item?.id ?? null));
      },
      { prefixes: ["task"] },
    );

  async function finish(
    id: string,
    action: () => Promise<boolean>,
    after: "advance" | "advance-or-stay" | "stay",
    initialSelection: string | null = id,
  ) {
    if (completing.current) return false;
    completing.current = true;
    try {
      const succeeded = await action();
      if (!succeeded || !workbench.current || latestId.current !== initialSelection) return succeeded;
      if (after !== "stay") {
        keepScroll.current = true;
        const next = nextReviewItem(sorted, id)?.id ?? null;
        if (!desktop && initialSelection === null) {
          setQueueCursor(next);
          requestAnimationFrame(() => focusQueue(next));
        } else if (next) {
          focusId.current = next;
          setReview(next);
        } else if (after === "advance-or-stay") {
          // 指定專案或回答後可能還需要核准，讓更新後的佇列決定是否關閉面板。
          focusAfterRemoval.current = id;
          reloadDetail((value) => value + 1);
        } else {
          setReview(null);
          requestAnimationFrame(() => focusQueue(null));
        }
      } else {
        reloadDetail((value) => value + 1);
      }
      return true;
    } finally {
      completing.current = false;
    }
  }

  function cancelQuickCheck() {
    if (!activeCheck.current) return;
    activeCheck.current = null;
    setChecking(false);
  }

  async function verifyAndApprove(expected: QuickApproval) {
    const id = expected.task.id;
    const initialSelection = reviewId;
    if (!workbench.current || latestId.current !== initialSelection || activeCheck.current ||
        completing.current || latest.current.busy || latest.current.suspended) return;
    const token = Symbol();
    activeCheck.current = token;
    setChecking(true);
    setQuickNotice(null);
    const stillHere = () => activeCheck.current === token && !!workbench.current &&
      !workbench.current.closest('[role="tabpanel"][data-state="inactive"]') &&
      latestId.current === initialSelection && !latest.current.busy && !latest.current.suspended;
    const reviewInstead = (text: string, detail?: Detail) => {
      setQuickNotice({ id, text });
      if (detail) setResult({ id, detail });
      if (id !== latestId.current) setReview(id);
    };
    try {
      const fresh = await loadTaskDetail(id);
      if (!stillHere()) return;
      const sameActor = await actions.verifyQuickActor();
      if (!stillHere()) return;
      if (!latest.current.admin || !sameActor || loadTaskDetail !== latest.current.loadTaskDetail) {
        setActorChanged(true);
        reviewInstead("登入身分已變更，尚未核准。請重新確認目前的身分與案件。", fresh);
        return;
      }
      const snapshot = latest.current.state;
      const current = quickApproval(snapshot.tasks.find((task) => task.id === id), snapshot, latest.current.admin);
      if (!current || !matchesApproval(current, fresh) || !matchesApproval(expected, fresh)) {
        reviewInstead("案件與清單不同，尚未核准。請重新確認目前的需求、專案與分支。", fresh);
        return;
      }
      await finish(id, () => actions.approveFromQueue(fresh.task, expected.body, (text, updated) => {
        const error: RowError = updated
          ? { text, version: updated.version, updated_at: updated.updated_at }
          : { text, awaitingUpdateFrom: latest.current.state.tasks };
        setRowErrors((errors) => ({ ...errors, [id]: error }));
      }), "advance", initialSelection);
    } catch (cause) {
      if (stillHere()) reviewInstead(`無法重新確認案件，尚未核准。${readError(cause)} 請重新載入後再試。`);
    } finally {
      if (activeCheck.current === token && workbench.current) cancelQuickCheck();
    }
  }

  function startApproval(approval: QuickApproval) {
    guard(() => void verifyAndApprove(approval), { prefixes: ["task"] });
  }

  const index = sorted.findIndex(({ id }) => id === item?.id);
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  const noticeText = actionError ?? (quickNotice?.id === item?.id ? quickNotice?.text : undefined);
  const actionNotice = noticeText && (
    <div
      role="alert"
      className="border-b bg-danger-soft px-4 py-3 text-sm text-danger wrap-anywhere"
    >
      {noticeText}
    </div>
  );
  const content = item && (
    <div
      ref={panel}
      data-review-id={item.id}
      data-review-version={detail?.task.version ?? list?.version}
      className={cn("min-w-0 [&_a[data-slot=button]]:max-lg:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:max-lg:min-h-11 [&_select]:max-lg:min-h-11 [&_summary]:max-lg:min-h-11", list && "max-lg:flex max-lg:h-full max-lg:flex-col")}
    >
      {(!desktop || !detail) && actionNotice && (
        <div className="sticky top-0 z-10">{actionNotice}</div>
      )}
      {list ? (
        <PickListForm
          key={`${list.id}:${list.version}`}
          list={list}
          group={item.group}
          busy={busy}
          resolve={(ids) =>
            finish(item.id, () => resolvePickList(list, ids), "advance")
          }
          onPrimaryMount={attachPrimary}
          mobile={!desktop}
        />
      ) : (
        <>
          {error && (
            <div
              role="alert"
              className="m-4 rounded-md bg-danger-soft p-3 text-sm text-danger"
            >
              <p>無法載入審核內容。{error} 請重新載入。</p>
              <Button
                data-review-error=""
                variant="outline"
                className="mt-2 text-foreground"
                onClick={() => reloadDetail((value) => value + 1)}
              >
                重新載入審核內容
              </Button>
            </div>
          )}
          {detail ? (
            <TaskReviewPanel
              key={detail.task.id}
              {...actions}
              detail={detail}
              state={state}
              busy={busy}
              admin={admin}
              reviewStatus={item.status}
              actionNotice={desktop ? actionNotice : undefined}
              actionDock={desktop ? null : actionDock}
              onPrimaryMount={attachPrimary}
              act={(task, action, body, done) =>
                finish(
                  task.id,
                  () => actions.act(task, action, body, done),
                  action === "assign" || action === "bind_assign"
                    ? "advance-or-stay"
                    : [
                          "approve",
                          "adopt",
                          "reject",
                          "cancel",
                          "retry",
                        ].includes(action)
                      ? "advance"
                      : "stay",
                )
              }
              answer={(task, text) =>
                finish(
                  task.id,
                  () => actions.answer(task, text),
                  "advance-or-stay",
                )
              }
              relink={(task, parentId) =>
                finish(
                  task.id,
                  async () => Boolean(await actions.relink(task, parentId)),
                  "stay",
                )
              }
            />
          ) : (
            !error && (
              <div
                role="status"
                className="space-y-3 p-5 text-sm text-muted-foreground"
              >
                <p>載入審核內容中…</p>
                <Skeleton aria-hidden className="h-8 w-2/3" />
                <Skeleton aria-hidden className="h-20 w-full" />
              </div>
            )
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      ref={workbench}
      tabIndex={-1}
      onClickCapture={cancelQuickCheck}
      onInputCapture={cancelQuickCheck}
      onKeyDownCapture={(event) => {
        cancelQuickCheck();
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
        const target = event.target;
        const button = primary.current;
        if (!event.altKey && target === button && (event.key === "j" || event.key === "k")) {
          event.preventDefault();
          const neighbor = event.key === "j" ? next : previous;
          if (neighbor && !busy && !suspended && !event.repeat) choose(neighbor.id, "enter");
          return;
        }
        if (event.key !== "Enter" || !event.altKey) return;
        event.preventDefault();
        if (busy || suspended || event.repeat || !(target instanceof HTMLElement)) return;
        if (!item || panel.current?.dataset.reviewId !== item.id) return;
        if (target !== button) {
          if (!event.currentTarget.contains(target) || target.closest<HTMLElement>("[data-review-row]")?.dataset.reviewRow !== item.id) return;
          const approval = quickApproval(state.tasks.find((task) => task.id === item.id), state, admin && !actorChanged);
          if (!rowErrors[item.id] && approval && detail && matchesApproval(approval, detail)) startApproval(approval);
          else choose(item.id, "enter");
          return;
        }
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        const version = panel.current.dataset.reviewVersion;
        const activate = () => {
          if (button === primary.current && button.isConnected && latestId.current === item.id &&
              panel.current?.dataset.reviewVersion === version && !button.disabled && button.getAttribute("aria-disabled") !== "true") button.click();
        };
        if (item.kind === "task") guard(activate, { prefixes: ["task"] });
        else activate();
      }}
      className={cn(
        "min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
        items.length > 0 &&
          // 寬螢幕把佇列放寬，群組與頻道名稱才不會被狀態字樣擠到截斷。
          "lg:grid lg:grid-cols-workbench lg:items-start lg:gap-4 xl:grid-cols-workbench-wide",
      )}
    >
      {items.length ? (
        <ReviewQueue
          items={sorted}
          selected={item?.id ?? (!desktop && sorted.some(({ id }) => id === queueCursor) ? queueCursor : null)}
          busy={busy || suspended}
          checking={checking}
          state={state}
          admin={admin && !actorChanged}
          detail={detail}
          decide={startApproval}
          rowErrors={rowErrors}
          desktop={desktop}
          choose={choose}
          batchControls={batchControls}
          checkbox={checkbox}
        />
      ) : (
        (empty ?? (
          <div className="work-ledger">
            <Empty icon={<CircleCheck />} title={inboxStatusLabels.clear} />
          </div>
        ))
      )}
      {desktop && items.length > 0 && (
        <section
          aria-label="審核面板"
          className="work-ledger min-w-0"
        >
          {item && !suspended ? (
            content
          ) : (
            <Empty title="選取一筆案件開始審核" compact />
          )}
        </section>
      )}
      {!desktop && item && !suspended && (
        <Sheet open onOpenChange={(open) => !open && close()}>
          <SheetContent
            aria-describedby={undefined}
            className="w-full max-w-none overflow-hidden sm:max-w-none"
            showCloseButton={false}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              sheetTitle.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (document.activeElement === document.body) focusQueue(item.id);
            }}
          >
            <SheetTitle ref={sheetTitle} tabIndex={-1} className="sr-only focus:outline-none!">{item.title}</SheetTitle>
            <nav
              aria-label="案件導覽"
              className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1"
            >
              <Button variant="ghost" className="min-h-11" onClick={close}>
                返回佇列
              </Button>
              <Button
                variant="outline"
                className="ml-auto min-h-11"
                disabled={!previous}
                onClick={() => previous && choose(previous.id, "enter")}
              >
                上一筆
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!next}
                onClick={() => next && choose(next.id, "enter")}
              >
                下一筆
              </Button>
            </nav>
            <div key={item.id} className="min-h-0 flex-1 overflow-y-auto">
              {content}
            </div>
            <div ref={setActionDock} className="shrink-0 bg-card">
              {!list && !detail && !error && keepScroll.current && (
                <p role="status" className="grid min-h-28 place-items-center border-t p-4 text-sm text-muted-foreground">
                  正在讀取下一筆
                </p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
