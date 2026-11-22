import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/form-controls";
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
import {
  groupPlatformLabels,
  inboxStatusLabels,
} from "../../shared/status-glossary.js";
import { PickListForm } from "./pick-list";
import { ago, Empty, message, type Detail, type State } from "./shared";
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

function waitingLabel(since: string | null) {
  if (!since) return "等待時間未提供";
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  if (days >= 1) return `等了 ${days} 天`;
  const relative = ago(since);
  return relative === "剛剛"
    ? "剛開始等待"
    : `等了 ${relative.replace(/前$/, "")}`;
}

type SelectionMode = "move" | "enter" | "click";

export function ReviewQueue({
  items,
  selected,
  sort,
  setSort,
  desktop,
  choose,
  batchControls,
  checkbox,
}: {
  items: readonly ReviewItem[];
  selected: string | null;
  sort: ReviewSort;
  setSort: (sort: ReviewSort) => void;
  desktop: boolean;
  choose: (id: string, mode: SelectionMode) => void;
  batchControls?: ReactNode;
  checkbox: (item: ReviewItem) => ReactNode;
}) {
  const queueId = useId();
  const tabbable = selected ?? items[0]?.id;
  return (
    <Tabs
      value={sort}
      onValueChange={(value) =>
        setSort(value === "newest" ? "newest" : "oldest")
      }
      className="min-w-0"
    >
      <TabsList
        aria-label="待決策排序"
        className="h-auto max-w-full shrink-0 overflow-x-auto"
      >
        <TabsTrigger
          value="oldest"
          aria-controls={queueId}
          className="min-h-11 flex-none lg:min-h-8"
        >
          等最久
        </TabsTrigger>
        <TabsTrigger
          value="newest"
          aria-controls={queueId}
          className="min-h-11 flex-none lg:min-h-8"
        >
          最新
        </TabsTrigger>
      </TabsList>
      {batchControls}
      <TabsContent id={queueId} value={sort} tabIndex={-1} className="min-w-0">
        <ul
          role="list"
          aria-label="待決策佇列"
          className="work-ledger divide-y"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex min-w-0 items-center gap-0.5 px-0.5"
            >
              {checkbox(item)}
              <button
                type="button"
                data-review-row={item.id}
                aria-current={selected === item.id ? "true" : undefined}
                tabIndex={tabbable === item.id ? 0 : -1}
                className="flex min-h-11 min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground aria-[current=true]:bg-muted aria-[current=true]:shadow-[inset_2px_0_var(--foreground)]"
                onClick={() => choose(item.id, "click")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!event.repeat)
                      setTimeout(() => choose(item.id, "enter"), 0);
                    return;
                  }
                  if (
                    !desktop ||
                    (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  )
                    return;
                  event.preventDefault();
                  const next =
                    items[index + (event.key === "ArrowDown" ? 1 : -1)];
                  if (next) setTimeout(() => choose(next.id, "move"), 0);
                }}
              >
                <span className="max-w-full truncate text-sm font-semibold">
                  {item.title}
                </span>
                <span className="flex w-full min-w-0 gap-x-2 text-xs text-muted-foreground">
                  <span className="truncate">{item.group}</span>
                  <span className="shrink-0">
                    {item.platform
                      ? groupPlatformLabels[item.platform]
                      : "平台未記錄"}
                  </span>
                </span>
                <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span data-review-status className="font-medium">
                    {item.status}
                  </span>
                  <span className="text-muted-foreground">
                    {waitingLabel(item.waitingSince)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </TabsContent>
    </Tabs>
  );
}

export type ReviewActions = Pick<
  TaskReviewPanelProps,
  "act" | "answer" | "followup" | "go" | "open" | "relink"
>;

type DetailResult = { id: string; detail?: Detail; error?: string };

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
  const desktop = useSyncExternalStore(subscribeToReviewLayout, isDesktopWidth);
  const guard = useGuard();
  const [sort, setSort] = useState<ReviewSort>("oldest");
  const [result, setResult] = useState<DetailResult | null>(null);
  const [reload, reloadDetail] = useState(0);
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
  latestId.current = reviewId;
  const workbench = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const focusId = useRef<string | null>(null);
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
      if (!first) requestAnimationFrame(() => workbench.current?.focus());
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
            error: message(e),
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
    target.focus();
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
    else workbench.current?.focus();
  }

  function choose(id: string, mode: SelectionMode) {
    const select = () => {
      focusAfterRemoval.current = null;
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
  ) {
    if (completing.current) return false;
    completing.current = true;
    try {
      const succeeded = await action();
      if (!succeeded || latestId.current !== id) return succeeded;
      if (after !== "stay") {
        const next = nextReviewItem(sorted, id)?.id ?? null;
        if (next) {
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

  const index = sorted.findIndex(({ id }) => id === item?.id);
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  const actionNotice = actionError && (
    <div
      role="alert"
      className="border-b bg-danger-soft px-4 py-3 text-sm text-danger [overflow-wrap:anywhere]"
    >
      {actionError}
    </div>
  );
  const content = item && (
    <div
      ref={panel}
      data-review-id={item.id}
      className="min-w-0 [&_a[data-slot=button]]:max-lg:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:max-lg:min-h-11 [&_select]:max-lg:min-h-11 [&_summary]:max-lg:min-h-11"
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
      className={cn(
        "min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
        items.length > 0 &&
          "lg:grid lg:grid-cols-[22.5rem_minmax(0,1fr)] lg:items-start lg:gap-4",
      )}
    >
      {items.length ? (
        <ReviewQueue
          items={sorted}
          selected={item?.id ?? null}
          sort={sort}
          setSort={setSort}
          desktop={desktop}
          choose={choose}
          batchControls={batchControls}
          checkbox={checkbox}
        />
      ) : (
        (empty ?? (
          <div className="work-ledger">
            <Empty title={inboxStatusLabels.clear} compact />
          </div>
        ))
      )}
      {desktop && items.length > 0 && (
        <section
          aria-label="審核面板"
          className="work-ledger min-w-0"
          key={item?.id}
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
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (document.activeElement === document.body) focusQueue(item.id);
            }}
          >
            <SheetTitle className="sr-only">{item.title}</SheetTitle>
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
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
