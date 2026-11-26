import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
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
  matchesDecision,
  ReviewQueue,
  type QuickDecision,
} from "./review-queue-list";
import { Empty, message, type Detail, type State } from "./shared";
import {
  TaskReviewPanel,
  type TaskReviewPanelProps,
} from "./task-review-panel";
import { useGuard } from "./unsaved";

export type ReviewActions = Pick<
  TaskReviewPanelProps,
  "act" | "answer" | "followup" | "go" | "open" | "relink" | "repairBaseline"
>;

type DetailResult = { id: string; detail?: Detail; error?: string };

function requestReason(cause: unknown) {
  const reason = message(cause);
  if (
    /^(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(
      reason,
    )
  )
    return navigator.onLine
      ? "未收到服務回應，請確認連線後再試。"
      : "裝置目前離線，請恢復網路連線後再試。";
  return reason;
}

export function ReviewWorkbench({
  items,
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
  const guard = useGuard();
  const [sort, setSort] = useState<ReviewSort>("oldest");
  const [cursor, setCursor] = useState<string | null>(null);
  const [inlineId, setInlineId] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState("");
  const [result, setResult] = useState<DetailResult | null>(null);
  const [reload, reloadDetail] = useState(0);
  const [pending, setPending] = useState<ReviewItem | null>(null);
  const completing = useRef(false);
  const sorted = sortReviewItems(items, sort);
  const selected = items.find(({ id }) => id === reviewId);
  const item = selected ?? (pending?.id === reviewId ? pending : null);
  const activeRow =
    item?.id ??
    items.find(({ id }) => id === cursor)?.id ??
    sorted[0]?.id ??
    null;
  const drawer = item && item.id !== inlineId && !suspended ? item : null;
  const taskId = drawer?.kind === "task" ? drawer.id : null;
  const list =
    drawer?.kind === "pickList"
      ? lists.find(({ id }) => pickListReviewId(id) === drawer.id)
      : undefined;
  const detail = taskId && result?.id === taskId ? result.detail : undefined;
  const error = taskId && result?.id === taskId ? result.error : undefined;
  const workbench = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const focusOnLoad = useRef<string | null>(null);
  const latestId = useRef(reviewId);
  latestId.current = reviewId;
  const latestAdmin = useRef(admin);
  latestAdmin.current = admin;
  const latestItems = useRef(sorted);
  latestItems.current = sorted;

  useLayoutEffect(() => {
    if (!inlineId || pending || inlineId !== reviewId || completing.current)
      return;
    if (actionError) setInlineNotice(requestReason(actionError));
    setInlineId(null);
    setReview(null, false);
  }, [inlineId, pending, reviewId, actionError, setReview]);

  function focusQueue(id: string | null) {
    const row =
      id &&
      workbench.current?.querySelector<HTMLButtonElement>(
        `[data-review-row="${CSS.escape(id)}"]`,
      );
    (row || workbench.current)?.focus({ preventScroll: true });
    return row;
  }

  useEffect(() => {
    if (
      !reviewId ||
      reviewId === inlineId ||
      selected ||
      busy ||
      completing.current ||
      suspended
    )
      return;
    const next = sortReviewItems(items, sort)[0]?.id ?? null;
    if (next) focusOnLoad.current = next;
    setReview(next, false);
  }, [
    reviewId,
    inlineId,
    selected,
    busy,
    items,
    sort,
    setReview,
    suspended,
    pending,
  ]);

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
      (cause) => {
        if (active)
          setResult((current) => ({
            id: taskId,
            detail: current?.id === taskId ? current.detail : undefined,
            error: requestReason(cause),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [taskId, state, reload, loadTaskDetail]);

  const attachPrimary = useCallback((button: HTMLButtonElement | null) => {
    primary.current = button;
  }, []);
  const focusPanel = useCallback(() => {
    const root = panel.current;
    if (!root || root.dataset.reviewId !== focusOnLoad.current) return;
    const target =
      primary.current?.isConnected && !primary.current.disabled
        ? primary.current
        : root.querySelector<HTMLElement>(
            "[data-task-project-choice]:enabled, [data-review-error], [data-task-title]",
          );
    if (!target) return;
    target.focus({ preventScroll: true });
    focusOnLoad.current = null;
  }, []);
  useEffect(() => {
    if (!busy) focusPanel();
  }, [busy, drawer?.id, detail, error, focusPanel]);

  function choose(id: string) {
    if (completing.current) return;
    guard(
      () => {
        focusOnLoad.current = id;
        setCursor(id);
        setInlineId(null);
        setInlineNotice("");
        setReview(id);
      },
      { prefixes: ["task"] },
    );
  }

  function close() {
    if (completing.current) return;
    guard(
      () => {
        focusOnLoad.current = null;
        setCursor(drawer?.id ?? null);
        setInlineNotice("");
        setReview(null);
      },
      { prefixes: ["task"] },
    );
  }

  async function finish(
    entry: ReviewItem,
    action: () => Promise<boolean>,
    after: "advance" | "advance-or-stay" | "stay",
    inline = false,
  ) {
    if (completing.current || busy) return false;
    completing.current = true;
    setPending(entry);
    try {
      const succeeded = await action();
      if (!succeeded || !workbench.current || latestId.current !== entry.id)
        return succeeded;
      const remaining = new Set(latestItems.current.map((row) => row.id));
      const next =
        nextReviewItem(
          sorted.filter((row) => row.id === entry.id || remaining.has(row.id)),
          entry.id,
        )?.id ??
        latestItems.current.find((row) => row.id !== entry.id)?.id ??
        null;
      if (
        after === "stay" ||
        (after === "advance-or-stay" && !next && remaining.has(entry.id))
      ) {
        reloadDetail((value) => value + 1);
      } else if (inline || !next) {
        setCursor(next);
        setInlineId(null);
        setReview(null, false);
        requestAnimationFrame(() => focusQueue(next));
      } else {
        focusOnLoad.current = next;
        setCursor(next);
        setReview(next, false);
      }
      return true;
    } finally {
      completing.current = false;
      setPending(null);
    }
  }

  async function quick(entry: ReviewItem, decision: QuickDecision) {
    if (!admin || busy || completing.current || suspended) return;
    setCursor(entry.id);
    setInlineNotice("");
    await finish(
      entry,
      async () => {
        let fresh: Detail;
        try {
          fresh = await loadTaskDetail(entry.id);
        } catch (cause) {
          if (workbench.current && !latestId.current)
            setInlineNotice(`無法確認目前的任務內容。${requestReason(cause)}`);
          return false;
        }
        if (!workbench.current || latestId.current) return false;
        if (!latestAdmin.current) {
          setInlineNotice("目前帳號不能使用快速動作，尚未送出決定。");
          return false;
        }
        if (!matchesDecision(decision, fresh)) {
          setInlineNotice(
            "案件內容與清單不同，尚未送出決定。請重新確認目前的需求與目標專案。",
          );
          focusOnLoad.current = entry.id;
          setResult({ id: entry.id, detail: fresh });
          setReview(entry.id);
          return false;
        }
        setInlineId(entry.id);
        setReview(entry.id, false);
        latestId.current = entry.id;
        return decision.kind === "retry"
          ? actions.act(decision.task, "retry", {}, "已重新排程")
          : actions.act(
              decision.task,
              "approve",
              decision.body,
              "已確認專案並核准，開始排程",
            );
      },
      "advance",
      true,
    );
  }

  const index = sorted.findIndex(({ id }) => id === drawer?.id);
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  const locked = busy || !!pending;
  const notice = actionError ? requestReason(actionError) : inlineNotice;
  const actionNotice = notice && (
    <p
      role="alert"
      className="border-b bg-warn-soft px-4 py-2.5 text-sm text-warn [overflow-wrap:anywhere]"
    >
      {notice}
    </p>
  );
  return (
    <div
      ref={workbench}
      tabIndex={-1}
      className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
    >
      {!drawer && actionNotice}
      {items.length ? (
        <ReviewQueue
          items={sorted}
          state={state}
          admin={admin}
          selected={activeRow}
          sort={sort}
          setSort={setSort}
          busy={locked}
          choose={choose}
          decide={(entry, decision) => void quick(entry, decision)}
          move={(id, focus) => {
            if (completing.current) return;
            if (inlineId && inlineId !== id) {
              setInlineId(null);
              setInlineNotice("");
              setReview(null, false);
            }
            setCursor(id);
            if (focus) {
              const row = focusQueue(id);
              if (row) row.scrollIntoView({ block: "nearest" });
            }
          }}
          batchControls={batchControls}
          checkbox={checkbox}
        />
      ) : (
        (empty ?? (
          <div className="work-ledger">
            <Empty
              icon={<CircleCheck />}
              title={inboxStatusLabels.clear}
              compact
            />
          </div>
        ))
      )}
      {drawer && (
        <Sheet open onOpenChange={(open) => !open && close()}>
          <SheetContent
            aria-describedby={undefined}
            showCloseButton={false}
            className="h-dvh w-full gap-0 overflow-hidden sm:max-w-2xl motion-reduce:animate-none"
            onOpenAutoFocus={(event) => {
              if (
                focusOnLoad.current === drawer.id &&
                primary.current?.isConnected
              ) {
                event.preventDefault();
                focusPanel();
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !document.querySelector('[role="dialog"][data-state="open"]') &&
                document.activeElement === document.body
              )
                focusQueue(
                  latestItems.current.find((row) => row.id === drawer.id)?.id ??
                    latestItems.current[0]?.id ??
                    null,
                );
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                !(event.target instanceof HTMLElement) ||
                event.target.closest('[role="dialog"]') !==
                  event.currentTarget ||
                event.target.closest(
                  'input, textarea, select, form, [contenteditable=true], [role="tablist"], [role="radiogroup"]',
                )
              )
                return;
              if (
                !["j", "k", "a"].includes(event.key) ||
                (event.key === "a" && !admin)
              )
                return;
              event.preventDefault();
              if (locked || event.repeat) return;
              if (event.key === "a") {
                if (
                  primary.current?.isConnected &&
                  !primary.current.disabled &&
                  primary.current.getAttribute("aria-disabled") !== "true"
                )
                  primary.current.click();
              } else {
                const target = event.key === "j" ? next : previous;
                if (target) choose(target.id);
              }
            }}
          >
            <SheetTitle asChild>
              <span className="sr-only">{drawer.title}</span>
            </SheetTitle>
            <nav
              aria-label="案件導覽"
              className="flex shrink-0 items-center gap-1 border-b px-2 py-1 sm:px-4"
            >
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11"
                onClick={close}
              >
                <ArrowLeft aria-hidden />
                返回佇列
              </Button>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                J／K 切換{admin && "，A 使用主動作"}
              </span>
              <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                {index >= 0 && `${index + 1}／${sorted.length}`}
              </span>
              <Button
                aria-keyshortcuts="k"
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-11"
                disabled={locked || !previous}
                onClick={() => previous && choose(previous.id)}
              >
                <ChevronLeft aria-hidden />
                <span className="sr-only sm:not-sr-only">上一筆</span>
              </Button>
              <Button
                aria-keyshortcuts="j"
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-11"
                disabled={locked || !next}
                onClick={() => next && choose(next.id)}
              >
                <span className="sr-only sm:not-sr-only">下一筆</span>
                <ChevronRight aria-hidden />
              </Button>
            </nav>
            <section
              key={drawer.id}
              ref={panel}
              data-review-id={drawer.id}
              aria-label="審核面板"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:max-md:min-h-11 [&_select]:max-md:min-h-11 [&_summary]:max-md:min-h-11"
            >
              {!detail && actionNotice}
              {error && (
                <div
                  role="alert"
                  className="m-4 rounded-md bg-danger-soft p-4 text-sm text-danger"
                >
                  <p>無法載入審核內容。{error} 請重新載入。</p>
                  <Button
                    data-review-error=""
                    variant="outline"
                    className="mt-3 text-foreground"
                    onClick={() => reloadDetail((value) => value + 1)}
                  >
                    重新載入審核內容
                  </Button>
                </div>
              )}
              {list ? (
                <PickListForm
                  key={`${list.id}:${list.version}`}
                  list={list}
                  group={drawer.group}
                  busy={locked}
                  resolve={(ids) =>
                    finish(drawer, () => resolvePickList(list, ids), "advance")
                  }
                  onPrimaryMount={attachPrimary}
                />
              ) : detail ? (
                <TaskReviewPanel
                  key={detail.task.id}
                  {...actions}
                  detail={detail}
                  state={state}
                  admin={admin}
                  busy={locked || !!error}
                  actionNotice={actionNotice}
                  reviewStatus={drawer.status}
                  onPrimaryMount={attachPrimary}
                  act={(task, action, body, done) =>
                    finish(
                      drawer,
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
                      drawer,
                      () => actions.answer(task, text),
                      "advance-or-stay",
                    )
                  }
                  relink={(task, parentId) =>
                    finish(
                      drawer,
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
            </section>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
