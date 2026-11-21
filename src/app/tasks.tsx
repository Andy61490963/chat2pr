import {
  taskListEmptyLabels,
  taskListLabels,
  taskStatusFilterLabels,
} from "../../shared/status-glossary.js";
import {
  countTaskFilterConditions,
  taskStatusFilterIds,
  taskStatusFilters,
} from "../../shared/task-list.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import {
  endedStatuses,
  unfinishedStatuses,
  type Task,
  type TaskPage,
  type TaskStatus,
} from "../../shared/types.js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TaskRow } from "./inbox";
import {
  type State,
  type Request,
  countOf,
  Empty,
  message,
  SectionTitle,
  writeQuery,
} from "./shared";

type TaskTab = keyof Omit<typeof taskListEmptyLabels, "filtered">;
const tabs: { id: TaskTab; label: string; statuses: TaskStatus[] | null }[] = [
  {
    id: "active",
    label: taskListLabels.active,
    statuses: unfinishedStatuses,
  },
  { id: "closed", label: taskListLabels.ended, statuses: endedStatuses },
  { id: "all", label: "全部", statuses: null },
];
type By = "project" | "group" | "none";
const defaults = {
  filter: "active",
  status: "",
  group: "all",
  project: "all",
  by: "",
  q: "",
};
const preferenceKeys = [
  "filter",
  "status",
  "group",
  "project",
  "by",
  "q",
] as const;

function statusPreference(values: string[]) {
  return taskStatusFilterIds.filter((id) => values.includes(id)).join(",");
}

function readPreferences(state: State, storageKey: string) {
  let params = new URLSearchParams(location.search);
  if (!preferenceKeys.some((key) => params.has(key))) {
    try {
      params = new URLSearchParams(localStorage.getItem(storageKey) ?? "");
    } catch {
      // 停用瀏覽器儲存時仍可用網址保留篩選。
    }
  }
  const pick = (
    key: keyof typeof defaults,
    valid: (value: string) => boolean,
  ) => {
    const value = params.get(key);
    return value && valid(value) ? value : defaults[key];
  };
  // 舊連結與記憶設定可能以狀態當作分頁。
  const filter = params.get("filter") ?? "";
  const status = params.get("status") ?? filter;
  return {
    filter: pick("filter", (value) => tabs.some((tab) => tab.id === value)),
    status: statusPreference(status.split(",")),
    group: pick("group", (value) => state.groups.some((g) => g.id === value)),
    project: pick(
      "project",
      (value) => value === "none" || state.projects.some((p) => p.id === value),
    ),
    by: pick("by", (value) => ["project", "group", "none"].includes(value)),
    q: params.get("q") ?? "",
  };
}

const desktopMedia = "(min-width: 48rem)";
const isMobileWidth = () => !window.matchMedia(desktopMedia).matches;
function subscribeToTaskLayout(onChange: () => void) {
  const query = window.matchMedia(desktopMedia);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function TaskRows({
  list,
  by,
  state,
  open,
}: {
  list: Task[];
  by: By;
  state: State;
  open: (id: string) => unknown;
}) {
  const sections = new Map<string, Task[]>();
  for (const task of list) {
    const key =
      by === "project"
        ? (task.project_id ?? "none")
        : by === "group"
          ? task.group_id
          : "";
    const section = sections.get(key);
    if (section) section.push(task);
    else sections.set(key, [task]);
  }
  return [...sections].map(([key, tasks]) => (
    <section key={key}>
      {by !== "none" && (
        <SectionTitle count={tasks.length}>
          {by === "project"
            ? (state.projects.find((p) => p.id === key)?.name ?? "未指定專案")
            : (state.groups.find((g) => g.id === key)?.name ?? "群組")}
        </SectionTitle>
      )}
      <div className="work-ledger">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            state={state}
            open={open}
            hide={by}
          />
        ))}
      </div>
    </section>
  ));
}

function TaskHistory({
  query,
  by,
  state,
  open,
  request,
  empty,
}: {
  query: string;
  by: By;
  state: State;
  open: (id: string) => unknown;
  request: Request;
  empty: React.ReactNode;
}) {
  const [page, setPage] = useState<TaskPage>({ tasks: [], next: null });
  const [load, setLoad] = useState<{
    cursor: TaskPage["next"];
    attempt: number;
  }>({ cursor: null, attempt: 0 });
  const [finished, setFinished] = useState<number | null>(null);
  const [failure, setFailure] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const manual = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const loading = finished !== load.attempt;

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams(query);
    if (load.cursor) {
      params.set("before", load.cursor.before);
      params.set("beforeId", load.cursor.beforeId);
    }
    void request<TaskPage>(`/api/tasks?${params}`)
      .then((batch) => {
        if (!current) return;
        setPage((previous) => {
          const tasks = new Map(previous.tasks.map((task) => [task.id, task]));
          for (const task of batch.tasks) tasks.set(task.id, task);
          return { tasks: [...tasks.values()], next: batch.next };
        });
        if (manual.current) setFocusId(batch.tasks[0]?.id ?? null);
        setFailure("");
      })
      .catch((error: unknown) => {
        if (current) {
          setFailure(
            error instanceof TypeError ? "連不到伺服器" : message(error),
          );
        }
      })
      .finally(() => {
        if (current) setFinished(load.attempt);
      });
    return () => {
      current = false;
    };
  }, [load, query, request]);

  useLayoutEffect(() => {
    if (!loading && !failure && manual.current) {
      if (
        document.activeElement === button.current ||
        document.activeElement === document.body
      ) {
        const row =
          focusId &&
          list.current?.querySelector<HTMLElement>(
            `[data-task-id="${CSS.escape(focusId)}"]`,
          );
        (row || list.current)?.focus();
      }
      manual.current = false;
    }
  }, [failure, focusId, loading]);

  useEffect(() => {
    const sentinel = footer.current;
    if (
      !sentinel ||
      loading ||
      failure ||
      !page.next ||
      !("IntersectionObserver" in window)
    )
      return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && document.activeElement !== button.current) {
        setLoad((previous) =>
          previous.attempt === finished
            ? { cursor: page.next, attempt: previous.attempt + 1 }
            : previous,
        );
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [failure, finished, loading, page.next]);

  return (
    <>
      <div ref={list} className="flex flex-col gap-6" tabIndex={-1}>
        <TaskRows list={page.tasks} by={by} state={state} open={open} />
      </div>
      {!page.tasks.length && !loading && !failure && empty}
      <div
        ref={footer}
        className="flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground"
      >
        <span role={failure && !loading ? "alert" : "status"}>
          {loading
            ? "正在載入任務。"
            : failure
              ? `載入任務失敗（${failure.replace(/[。！]$/, "")}），請按「重試載入任務」。`
              : page.tasks.length > 0 &&
                `你已看到 ${page.tasks.length} 筆任務。`}
        </span>
        {(page.next || failure) && (
          <Button
            ref={button}
            variant="outline"
            size="sm"
            aria-disabled={loading}
            onClick={() => {
              if (loading) return;
              manual.current = true;
              setLoad({
                cursor: failure ? load.cursor : page.next,
                attempt: load.attempt + 1,
              });
            }}
          >
            {failure ? "重試載入任務" : "載入更多任務"}
          </Button>
        )}
      </div>
    </>
  );
}

export function TasksView({
  state,
  open,
  request,
  login,
  historyRevision,
}: {
  state: State;
  open: (id: string) => unknown;
  request: Request;
  login: string;
  historyRevision: number;
}) {
  const storageKey = `agentflow-tasks:${login}`;
  const [preferences, setPreferences] = useState(() =>
    readPreferences(state, storageKey),
  );
  const { filter, group, project, status, q: search } = preferences;
  const mobile = useSyncExternalStore(subscribeToTaskLayout, isMobileWidth);
  const isHistory = filter === "all" || filter === "closed";
  const by = (preferences.by || (isHistory ? "none" : "project")) as By;
  const closedTab = useRef<HTMLButtonElement>(null);
  const allTab = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const change = (updates: Partial<typeof preferences>) => {
    const next = { ...preferences, ...updates };
    setPreferences(next);
    try {
      localStorage.setItem(storageKey, new URLSearchParams(next).toString());
    } catch {
      // 瀏覽器無法儲存偏好時仍保留此頁的操作。
    }
  };
  useEffect(() => {
    // 網址明列分頁，分享預設分頁時也不會套用收件者的上次選擇。
    if (location.pathname === "/tasks") {
      writeQuery(
        preferenceKeys.map((key) => [
          key,
          preferences[key],
          key === "filter" ? "" : defaults[key],
        ]),
      );
    }
  }, [preferences]);
  useEffect(() => {
    const onPop = () => {
      if (location.pathname === "/tasks")
        setPreferences(readPreferences(state, storageKey));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [state, storageKey]);
  const selectedStatuses = status.split(",");
  const visibleStatuses = status
    ? taskStatusFilterIds
        .filter((id) => selectedStatuses.includes(id))
        .flatMap((id) => taskStatusFilters[id])
    : unfinishedStatuses;
  const narrowed =
    (!isHistory && status !== "") ||
    group !== "all" ||
    project !== "all" ||
    search !== "";
  // 分頁數字：全部用總筆數，其餘依伺服器的各狀態數量加總。
  const tabCount = (statuses: TaskStatus[] | null) =>
    statuses
      ? countOf(state, statuses)
      : (state.totals?.tasks ?? state.tasks.length);
  const omitted = state.totals?.unfinishedOmitted ?? 0;
  const list = isHistory
    ? []
    : state.tasks.filter(
        (t) =>
          visibleStatuses.includes(t.status) &&
          (group === "all" || t.group_id === group) &&
          (project === "all" || (t.project_id ?? "none") === project) &&
          `${t.title} ${t.summary}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      );
  const params = new URLSearchParams({ filter });
  if (group !== "all") params.set("group", group);
  if (project !== "all") params.set("project", project);
  if (search) params.set("q", search);
  const currentTab = tabs.find((tab) => tab.id === filter) ?? tabs[0];
  const emptyTab =
    tabCount(currentTab.statuses) === 0 &&
    !state.tasks.some(
      (task) => currentTab.statuses?.includes(task.status) ?? true,
    );
  const empty = (
    <Card>
      {emptyTab && !isHistory ? (
        <Empty title={taskListEmptyLabels.active}>
          <span className="flex flex-col items-center gap-3">
            有新任務或進度變動時，你會在這裡看到。
            <Button
              variant="outline"
              onClick={() => {
                change({ filter: "closed" });
                closedTab.current?.focus();
              }}
            >
              看已結束的任務
            </Button>
          </span>
        </Empty>
      ) : !emptyTab && narrowed ? (
        <Empty title={taskListEmptyLabels.filtered}>
          <span className="flex flex-col items-center gap-3">
            你可以清除篩選，或換個字詞搜尋。
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                change({
                  status: isHistory ? status : "",
                  group: "all",
                  project: "all",
                  q: "",
                });
                searchField.current?.focus();
              }}
            >
              清除篩選
            </Button>
          </span>
        </Empty>
      ) : (
        <Empty title={taskListEmptyLabels[currentTab.id]}>
          {filter === "all" ? (
            "你可以在已綁定專案的群組提出需求，整理完成後就會出現在這裡。"
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                change({ filter: "all" });
                allTab.current?.focus();
              }}
            >
              看全部任務
            </Button>
          )}
        </Empty>
      )}
    </Card>
  );
  const filterCount = countTaskFilterConditions({
    statuses: selectedStatuses,
    group,
    project,
    by,
    isHistory,
  });
  const statusControls = !isHistory && (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm text-muted-foreground">
        你可以勾選多個狀態，未勾選時會顯示這個分頁的所有任務。
      </legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-x-2 sm:flex sm:flex-wrap sm:gap-x-4">
        {taskStatusFilterIds.map((id) => (
          <label
            key={id}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted has-focus-visible:outline-2 has-focus-visible:outline-foreground"
          >
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-primary"
              checked={selectedStatuses.includes(id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selectedStatuses, id]
                  : selectedStatuses.filter((value) => value !== id);
                change({ status: statusPreference(next) });
              }}
            />
            <span>
              {taskStatusFilterLabels[id]}{" "}
              <span className="text-xs text-muted-foreground tabular-nums">
                {tabCount(taskStatusFilters[id])}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  const selectContentProps = mobile
    ? {
        position: "popper" as const,
        className:
          "max-w-(--radix-select-content-available-width) [&_[role=option]]:min-h-11 [&_[role=option]]:break-all",
      }
    : {};
  const selectControls = (
    <>
      <Select value={group} onValueChange={(group) => change({ group })}>
        <SelectTrigger
          className="w-40 max-w-full max-md:w-full"
          aria-label="群組"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps}>
          <SelectItem value="all">所有群組</SelectItem>
          {state.groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={project} onValueChange={(project) => change({ project })}>
        <SelectTrigger
          className="w-44 max-w-full max-md:w-full"
          aria-label="專案"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps}>
          <SelectItem value="all">所有專案</SelectItem>
          {state.projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          <SelectItem value="none">未指定專案</SelectItem>
        </SelectContent>
      </Select>
      <Select value={by} onValueChange={(by) => change({ by })}>
        <SelectTrigger
          className="w-36 max-w-full max-md:w-full"
          aria-label="分組方式"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps}>
          <SelectItem value="project">依專案分組</SelectItem>
          <SelectItem value="group">依群組分組</SelectItem>
          <SelectItem value="none">不分組</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
  const searchControl = (
    <div className="relative min-w-0 flex-1 md:basis-48">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={searchField}
        className="pl-9"
        placeholder="搜尋任務"
        aria-label="搜尋任務"
        value={search}
        onChange={(e) => change({ q: e.target.value })}
      />
    </div>
  );
  return (
    <Tabs
      value={filter}
      onValueChange={(filter) => change({ filter })}
      className="work-surface min-w-0 gap-4 md:gap-6"
    >
      <div className="flex flex-col gap-3">
        <TabsList
          aria-label="任務分頁"
          className="grid h-auto w-full grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))] items-stretch overflow-visible sm:flex sm:flex-wrap sm:justify-start"
        >
          {tabs.map((f) => (
            <TabsTrigger
              key={f.id}
              ref={
                f.id === "closed"
                  ? closedTab
                  : f.id === "all"
                    ? allTab
                    : undefined
              }
              value={f.id}
              className="h-auto min-h-11 flex-none flex-wrap gap-y-0 px-1 text-center whitespace-normal sm:px-2.5"
            >
              {f.label}
              <span className="text-xs text-muted-foreground">
                {tabCount(f.statuses)}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {!emptyTab && (
          <>
            {!mobile && statusControls}
            {!isHistory && omitted > 0 && (
              <p role="status" className="text-sm text-warn">
                你可以到「全部」查看這裡尚未載入的 {omitted} 筆較舊任務。
              </p>
            )}
            {mobile ? (
              <div className="flex min-w-0 items-center gap-2">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      variant="outline"
                      className="shrink-0 border-muted-foreground focus-visible:outline-2 focus-visible:outline-foreground"
                      aria-label={`篩選，已套用 ${filterCount} 個條件`}
                    >
                      <SlidersHorizontal />
                      篩選{filterCount > 0 && `（${filterCount}）`}
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="max-h-[85dvh]">
                    <SheetHeader>
                      <SheetTitle>任務篩選</SheetTitle>
                      <SheetDescription>
                        選擇條件後，任務清單會立即更新。
                      </SheetDescription>
                    </SheetHeader>
                    <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                      {statusControls}
                      {selectControls}
                    </div>
                  </SheetContent>
                </Sheet>
                {searchControl}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selectControls}
                {searchControl}
              </div>
            )}
          </>
        )}
      </div>
      {tabs.map((f) => (
        <TabsContent
          key={f.id}
          value={f.id}
          className="data-[state=active]:flex flex-col gap-6"
        >
          {f.id === filter &&
            (emptyTab ? (
              empty
            ) : isHistory ? (
              <TaskHistory
                key={`${historyRevision}:${params}`}
                query={params.toString()}
                by={by}
                state={state}
                open={open}
                request={request}
                empty={empty}
              />
            ) : list.length ? (
              <TaskRows list={list} by={by} state={state} open={open} />
            ) : (
              empty
            ))}
        </TabsContent>
      ))}
    </Tabs>
  );
}
