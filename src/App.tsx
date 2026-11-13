import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Brain,
  CircleCheck,
  CirclePause,
  Ellipsis,
  FolderGit2,
  FolderX,
  GitPullRequest,
  Inbox,
  ListChecks,
  Loader2,
  LogOut,
  MessageSquare,
  RefreshCw,
  Server,
  UserCog,
  Settings2,
  Unplug,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Wordmark } from "@/components/brand";
import type { Action, Project, Settings, Task } from "../shared/types.js";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { GroupsView } from "./app/groups";
import { ChatView } from "./app/chat";
import { InboxView } from "./app/inbox";
import { ProjectForm, ProjectsView } from "./app/projects";
import { applyTheme, pickSettings, SettingsView } from "./app/settings";
import {
  type Account,
  type Detail,
  type Request,
  type Run,
  type State,
  type View,
  attention,
  cash,
  Initials,
  message,
} from "./app/shared";
import { TaskDrawer } from "./app/task-drawer";
import { TasksView } from "./app/tasks";
import { SystemView } from "./app/system";
import { MembersView } from "./app/members";
import { AlertBell } from "./app/alerts";
import { readApiResponse } from "./app/api-response";
import { useGuard } from "./app/unsaved";

export { applyTheme };
const views = [
  {
    id: "inbox",
    label: "收件匣",
    icon: Inbox,
    section: "工作區",
    hint: "需要你決定的事、進行中的工作與最新動態",
  },
  {
    id: "tasks",
    label: "任務",
    icon: ListChecks,
    section: "工作區",
    hint: "從群組對話整理出的所有需求與開發進度",
  },
  {
    id: "chat",
    label: "聊天室",
    icon: MessageSquare,
    section: "工作區",
    hint: "機器人收到的群組對話與判讀結果，僅供閱讀，回覆請用 LINE",
  },
  {
    id: "groups",
    label: "群組",
    icon: UsersRound,
    section: "管理",
    hint: "設定每個 LINE 群組可修改的專案與 AI 記憶",
  },
  {
    id: "projects",
    label: "專案",
    icon: FolderGit2,
    section: "管理",
    hint: "每個專案對應一個 GitHub 儲存庫，說明寫清楚能讓 AI 正確分派",
  },
  {
    id: "system",
    label: "系統",
    icon: Server,
    section: "管理",
    hint: "容器狀態、記憶總覽與系統架構說明",
  },
  {
    id: "members",
    label: "成員",
    icon: UserCog,
    section: "管理",
    hint: "決定哪些同事可以登入看板，以及能做什麼",
  },
  {
    id: "settings",
    label: "設定",
    icon: Settings2,
    section: "管理",
    hint: "AI 模式、訂閱額度、服務連線與通知",
  },
] as const;

// 每個頁面有自己的網址，任務詳情以 ?task= 表示；重新整理、上一頁與分享連結都會回到同一處。
const viewPaths: Record<View, string> = {
  inbox: "/",
  tasks: "/tasks",
  chat: "/chat",
  groups: "/groups",
  projects: "/projects",
  system: "/system",
  members: "/members",
  settings: "/settings",
};
const viewFromPath = (path: string): View =>
  (Object.entries(viewPaths) as [View, string][]).find(
    ([, p]) => p === (path.replace(/\/+$/, "") || "/"),
  )?.[0] ?? "inbox";
// 手機底部列放不下的頁面收進「更多」。
const mobileMore: readonly View[] = ["system", "members"];
const writeUrl = (view: View, task: string | null, push = true) => {
  // 同一頁開關任務詳情時保留篩選等參數；換頁就清掉。
  const q = new URLSearchParams(
    viewPaths[view] === location.pathname ? location.search : "",
  );
  if (task) q.set("task", task);
  else q.delete("task");
  const qs = q.toString();
  const url = viewPaths[view] + (qs ? `?${qs}` : "");
  if (url === location.pathname + location.search) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
};
// 會讓收訊、派工或通知停擺的服務；異常時在每一頁上方提醒管理者。
const vital: Record<string, string> = {
  line: "LINE",
  github: "GitHub App",
  codex: "Codex 訂閱登入",
  openai: "OpenAI API",
  runner: "隔離執行器",
  tunnel: "HTTPS 入口",
  notifications: "LINE 私訊通知",
};
// 登入前所在的網址：GitHub 登入回來後回到這裡（例如 LINE 通知裡的任務連結）。
const returnKey = "agentflow-return";

export function App() {
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname)),
    [state, setState] = useState<State | null>(null),
    [user, setUser] = useState<{
      csrf: string;
      login: string;
      role?: "admin" | "member";
    } | null>(null),
    [configured, setConfigured] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    // 失敗的提示用紅色、停留較久，才不會跟「已儲存」混在一起又一閃而過。
    [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
      null,
    ),
    [selected, setSelected] = useState<Detail | null>(null),
    [busy, setBusy] = useState(false),
    [project, setProject] = useState<Partial<Project> | null>(null),
    // 每次從導覽切換頁面就加一，讓該頁丟掉上一輪的篩選、照網址重新開始。
    [visit, setVisit] = useState(0),
    [offline, setOffline] = useState(false),
    [, setTick] = useState(0),
    [account, setAccount] = useState<Account | null | string>(null);
  // 「3 分鐘前」這類相對時間每分鐘重算一次，畫面放著不動也不會過時。
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);
  // 不存在的路徑會顯示收件匣，網址一併改回來，避免把錯的連結分享出去。
  useEffect(() => {
    const path = viewPaths[viewFromPath(location.pathname)];
    if (path !== location.pathname)
      history.replaceState(null, "", path + location.search);
  }, []);
  const request = useCallback<Request>(
    async (url, method = "GET", body) => {
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(user ? { "x-csrf-token": user.csrf } : {}),
        },
        body: ["GET", "HEAD"].includes(method)
          ? undefined
          : JSON.stringify(body ?? {}),
      });
      if (response.status === 401) {
        setUser(null);
        setState(null);
      }
      return readApiResponse(response);
    },
    [user],
  );
  const guard = useGuard();
  // 任務與動態只載入最近的一部分；按「載入更多」才加大範圍。
  const limits = useRef({ tasks: 250, activity: 80 });
  const refresh = useCallback(async () => {
    try {
      const { tasks, activity } = limits.current;
      setState(
        await request<State>(`/api/state?tasks=${tasks}&activity=${activity}`),
      );
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [request]);
  useEffect(() => {
    void (async () => {
      try {
        const info = await readApiResponse<{ githubConfigured: boolean }>(
          await fetch("/api/public/status"),
        );
        setConfigured(!!info.githubConfigured);
        const r = await fetch("/api/me");
        if (r.ok) setUser(await readApiResponse(r));
      } catch {
        setError("無法連線到本機服務，請檢查啟動狀態。");
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const events = new EventSource("/api/events");
    events.addEventListener("update", () => void refresh());
    // 斷線幾秒內自己接回來就不打擾；持續接不上才提示畫面可能不是最新。
    let lost: ReturnType<typeof setTimeout> | undefined;
    events.addEventListener("connected", () => {
      clearTimeout(lost);
      lost = undefined;
      setOffline(false);
      void refresh();
    });
    events.addEventListener("error", () => {
      lost ??= setTimeout(() => {
        setOffline(true);
        // 瀏覽器放棄重連時（例如登入過期）主動問一次，該登出就登出。
        if (events.readyState === EventSource.CLOSED) void refresh();
      }, 4000);
    });
    return () => {
      clearTimeout(lost);
      events.close();
      setOffline(false);
    };
  }, [user, refresh]);
  // 分頁標題跟著頁面與任務走，多開分頁時分得出來；有待處理的事會顯示數量。
  const waiting = state?.tasks.filter((t) =>
    attention.includes(t.status),
  ).length;
  const pageLabel = views.find((v) => v.id === view)?.label;
  const taskTitle = selected?.task.title;
  useEffect(() => {
    document.title = user
      ? `${waiting ? `(${waiting}) ` : ""}${taskTitle ?? pageLabel}｜AgentFlow`
      : "AgentFlow｜LINE 需求到 PR";
  }, [user, waiting, pageLabel, taskTitle]);
  // 一般成員打開管理頁的網址時回到收件匣，網址也跟著改。
  useEffect(() => {
    if (
      user?.role === "member" &&
      views.find((v) => v.id === view)?.section !== "工作區"
    ) {
      setView("inbox");
      history.replaceState(null, "", "/");
    }
  }, [user, view]);
  // 訂閱額度每 5 分鐘更新一次；字串代表讀取失敗的原因。
  const loadAccount = useCallback(
    async (fresh = false) => {
      try {
        setAccount(
          await request<Account>(
            `/api/codex/account${fresh ? "?fresh=1" : ""}`,
          ),
        );
      } catch (e) {
        setAccount(message(e));
      }
    },
    [request],
  );
  const subscription = state?.settings.ai_mode === "subscription";
  useEffect(() => {
    if (!user || !subscription) return;
    void loadAccount();
    const t = setInterval(() => void loadAccount(), 300000);
    return () => clearInterval(t);
  }, [user, subscription, loadAccount]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const openTask = useCallback(
    async (id: string, push = true) => {
      try {
        setSelected(await request<Detail>(`/api/tasks/${id}`));
        writeUrl(viewRef.current, id, push);
      } catch (e) {
        setToast({ text: message(e), error: true });
        // 連結裡的任務打不開時把它從網址拿掉，重新整理才不會一直跳同一個錯誤。
        if (new URLSearchParams(location.search).get("task") === id) {
          setSelected(null);
          writeUrl(viewRef.current, null, false);
        }
      }
    },
    [request],
  );
  const closeTask = () => {
    setSelected(null);
    writeUrl(viewRef.current, null);
  };
  // 記下目前網址：按上一頁時若選擇繼續編輯，要把網址改回來。
  const lastUrl = useRef(location.pathname + location.search);
  useEffect(() => {
    lastUrl.current = location.pathname + location.search;
  });
  // 瀏覽器上一頁／下一頁：依網址切換頁面與任務詳情。
  useEffect(() => {
    const onPop = () => {
      // 確認視窗開啟期間仍可能收到 SSE；先保存網址，避免重新渲染改寫返回位置。
      const previousUrl = lastUrl.current;
      const destination = location.pathname + location.search;
      guard(
        () => {
          const url = new URL(destination, location.origin);
          setView(viewFromPath(url.pathname));
          const id = url.searchParams.get("task");
          if (id) void openTask(id, false);
          else setSelected(null);
        },
        { cancel: () => history.pushState(null, "", previousUrl) },
      );
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openTask, guard]);
  useEffect(() => {
    const id = selected?.task.id;
    if (!state || !id) return;
    let active = true;
    void request<Detail>(`/api/tasks/${id}`)
      .then(
        (d) => active && setSelected((cur) => (cur?.task.id === id ? d : cur)),
      )
      .catch((e) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, [state, selected?.task.id, request]);
  useEffect(() => {
    if (!user) return;
    let back: string | null = null;
    try {
      back = sessionStorage.getItem(returnKey);
      sessionStorage.removeItem(returnKey);
    } catch {
      // 無法讀取時停在首頁。
    }
    if (
      back &&
      back.startsWith("/") &&
      location.pathname === "/" &&
      !location.search
    ) {
      history.replaceState(null, "", back);
      setView(viewFromPath(location.pathname));
    }
    const id = new URLSearchParams(location.search).get("task");
    if (id) void openTask(id, false);
  }, [user, openTask]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 12000 : 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const run: Run = async (fn, done = "已儲存") => {
    setBusy(true);
    try {
      await fn();
      setToast({ text: done });
      await refresh();
    } catch (e) {
      setToast({ text: message(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const act = (task: Task, action: Action, body: object = {}, done?: string) =>
    run(async () => {
      await request(`/api/tasks/${task.id}/actions`, "POST", {
        action,
        version: task.version,
        ...body,
      });
      if (selected?.task.id === task.id)
        setSelected(await request<Detail>(`/api/tasks/${task.id}`));
    }, done ?? "任務已更新");
  const leave = (v: View) => {
    setView(v);
    setSelected(null);
    // 從導覽進入一律是乾淨的頁面：不帶上一輪的篩選。
    if (viewPaths[v] !== location.pathname || location.search)
      history.pushState(null, "", viewPaths[v]);
    setVisit((n) => n + 1);
    window.scrollTo({ top: 0 });
  };
  // 換頁前先確認沒有未儲存的修改。
  const go = (v: View) => guard(() => leave(v));
  // 收件匣統計卡直接開啟對應篩選的任務列表。
  const showTasks = (filter: string) =>
    guard(() => {
      leave("tasks");
      history.replaceState(null, "", `${viewPaths.tasks}?filter=${filter}`);
    });
  // 已開著另一個任務、而且補充需求還沒送出時，先問再切換。
  const showTask = (id: string) =>
    guard(() => void openTask(id), { prefixes: ["task"] });
  const loadMore = (kind: "tasks" | "activity") => {
    limits.current = {
      ...limits.current,
      [kind]: Math.min(
        limits.current[kind] * 2,
        kind === "tasks" ? 5000 : 2000,
      ),
    };
    return refresh();
  };
  const logout = () => void run(() => request("/api/logout", "POST"), "已登出");
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 正在連線…
      </div>
    );
  if (!user) return <Login configured={configured} error={error} />;
  const needs = state?.tasks.filter((t) => attention.includes(t.status)) ?? [];
  const togglePause = () =>
    state &&
    run(
      () =>
        request("/api/settings", "PUT", {
          ...pickSettings(state.settings),
          paused: !state.settings.paused,
        }),
      state.settings.paused ? "已開始自動派工" : "已暫停派工，仍會接收訊息",
    );
  // 一般成員只看得到工作區；管理區（群組、專案、系統、成員、設定）限管理者。
  const admin = user.role !== "member";
  const goneProjects = (state?.projects ?? []).filter((p) => p.repo_missing_at);
  const down = (state?.health ?? []).filter(
    (h) =>
      !h.ok &&
      vital[h.name] &&
      (!["codex", "openai"].includes(h.name) ||
        (h.name === "codex") === (state?.settings.ai_mode === "subscription")),
  );
  const visible = views.filter((v) => admin || v.section === "工作區");
  const current = visible.find((v) => v.id === view) ?? visible[0];
  const live = state && !state.settings.paused;
  return (
    <div
      className={cn(
        "min-h-screen md:grid md:grid-cols-[15.5rem_minmax(0,1fr)]",
        current.id === "chat" && "h-dvh min-h-0 overflow-hidden",
      )}
    >
      <aside
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t bg-sidebar/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-6 md:border-t-0 md:border-r md:bg-sidebar md:px-3 md:py-4",
          current.id === "chat" && "md:h-dvh md:overflow-y-auto",
        )}
      >
        <div className="hidden items-center gap-2.5 px-2 md:flex">
          <Wordmark />
        </div>
        <nav className="flex justify-around md:flex-col md:justify-start md:gap-0.5">
          {visible.map(({ id, label, icon: Icon, section }, i) => (
            <div key={id} className="contents">
              {section !== visible[i - 1]?.section && (
                <p
                  className={cn(
                    "hidden px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 md:block",
                    i > 0 && "md:mt-4",
                  )}
                >
                  {section}
                </p>
              )}
              <button
                aria-label={label}
                aria-current={current.id === id ? "page" : undefined}
                onClick={() => go(id)}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] text-muted-foreground transition-colors md:flex-none md:flex-row md:gap-3 md:rounded-md md:px-3 md:py-1.5 md:text-sm hover:text-foreground md:hover:bg-sidebar-accent",
                  current.id === id &&
                    "font-medium text-brand-foreground md:bg-sidebar-accent md:text-foreground",
                  // 手機底部列空間有限，系統與成員收進「更多」。
                  mobileMore.includes(id) && "hidden md:flex",
                )}
              >
                <Icon
                  className={cn(
                    "size-5 md:size-4",
                    current.id === id && "md:text-brand-foreground",
                  )}
                />
                {label}
                {id === "inbox" && needs.length > 0 && (
                  <span className="absolute top-1 right-[calc(50%-1.25rem)] min-w-4 rounded-full bg-warn px-1 text-[10px] leading-4 font-semibold text-background md:static md:ml-auto md:bg-warn-soft md:px-1.5 md:text-xs md:text-warn">
                    {needs.length}
                  </span>
                )}
              </button>
            </div>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="更多"
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:hidden",
                  mobileMore.includes(current.id) &&
                    "font-medium text-brand-foreground",
                )}
              >
                <Ellipsis className="size-5" />
                更多
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-60">
              <DropdownMenuLabel className="flex items-center gap-2">
                <Initials name={user.login} />
                <span className="min-w-0 truncate">{user.login}</span>
              </DropdownMenuLabel>
              {state && (
                <DropdownMenuItem
                  disabled={!admin}
                  className="flex-col items-start gap-0.5 data-[disabled]:opacity-100"
                  onSelect={() => go("settings")}
                >
                  <QuotaLines
                    settings={state.settings}
                    usage={state.usage}
                    account={account}
                  />
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {visible
                .filter((v) => mobileMore.includes(v.id))
                .map(({ id, label, icon: Icon }) => (
                  <DropdownMenuItem key={id} onSelect={() => go(id)}>
                    <Icon /> {label}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuItem onSelect={logout}>
                <LogOut /> 登出
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
        {state && (
          <div className="mt-auto hidden flex-col gap-3 md:flex">
            <ModeSummary
              settings={state.settings}
              usage={state.usage}
              account={account}
              open={admin ? () => go("settings") : undefined}
            />
            <div className="flex items-center gap-2.5 border-t px-2 pt-3">
              <Initials name={user.login} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {user.login}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="登出"
                title="登出"
                className="text-muted-foreground"
                onClick={logout}
              >
                <LogOut />
              </Button>
            </div>
          </div>
        )}
      </aside>
      <main
        className={cn(
          "mx-auto w-full max-w-6xl px-4 pt-5 pb-28 md:px-8 md:pt-7 md:pb-12",
          current.id === "chat" &&
            "flex h-full min-h-0 flex-col overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6",
        )}
      >
        <header
          className={cn(
            "mb-7 flex flex-wrap items-start justify-between gap-3",
            current.id === "chat" && "mb-4 shrink-0",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight md:text-[26px]">
                {current.label}
              </h1>
              <p className="mt-0.5 hidden text-sm text-muted-foreground sm:block">
                {current.hint}
              </p>
            </div>
          </div>
          {state && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !admin}
                onClick={() => void togglePause()}
                aria-label={
                  state.settings.paused
                    ? "已暫停，點此開始自動派工"
                    : "點此暫停派工"
                }
                title={
                  state.settings.paused
                    ? "目前只接收訊息，不辨識與派工；點此開始"
                    : state.settings.triage_paused
                      ? "新需求判讀已暫停，已核准任務仍可執行；點此暫停派工"
                      : "已確認修改與明確查詢會依序派工；點此暫停"
                }
                className="font-normal"
              >
                <span
                  className={cn(
                    "inline-flex size-1.5 rounded-full",
                    live ? "bg-good" : "bg-warn",
                  )}
                />
                {state.settings.paused
                  ? "已暫停"
                  : state.settings.triage_paused
                    ? "判讀暫停中"
                    : "自動派工中"}
              </Button>
              <AlertBell
                alerts={state.alerts ?? []}
                seenAt={state.alertsSeenAt ?? null}
                request={request}
                open={showTask}
                openView={admin ? go : undefined}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="重新整理"
                title="重新整理"
                onClick={() => void refresh()}
              >
                <RefreshCw />
              </Button>
            </div>
          )}
        </header>
        {admin && goneProjects.length > 0 && view !== "projects" && (
          <p
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <FolderX className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              專案{goneProjects.map((p) => `「${p.name}」`).join("")}
              的儲存庫找不到了（可能已刪除、搬家或改名），已先停用並暫時解除群組綁定。
            </span>
            <Button variant="outline" size="xs" onClick={() => go("projects")}>
              查看專案
            </Button>
          </p>
        )}
        {admin && down.length > 0 && view !== "settings" && (
          <p
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <Unplug className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {down.map((h) => vital[h.name]).join("、")}
              連線異常，恢復前相關功能會停擺。
            </span>
            <Button variant="outline" size="xs" onClick={() => go("settings")}>
              前往設定
            </Button>
          </p>
        )}
        {state && (state.settings.paused || state.settings.triage_paused) && (
          <p
            role="status"
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
          >
            <CirclePause className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {state.settings.paused
                ? "派工已暫停：訊息照常接收，但不辨識新需求，也不開始任何工作。"
                : "新需求判讀已暫停：訊息照常接收，已核准的任務仍會執行。"}
            </span>
            {admin &&
              (state.settings.paused ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => void togglePause()}
                >
                  開始派工
                </Button>
              ) : (
                view !== "settings" && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => go("settings")}
                  >
                    前往設定
                  </Button>
                )
              ))}
          </p>
        )}
        {offline && (
          <p
            role="status"
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
          >
            <WifiOff className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              即時更新中斷了，正在重新連線；畫面可能不是最新狀態。
            </span>
            <Button variant="outline" size="xs" onClick={() => void refresh()}>
              立即更新
            </Button>
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" size="xs" onClick={() => void refresh()}>
              重試
            </Button>
          </p>
        )}
        {!state ? (
          <div className="flex min-h-60 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 載入中…
          </div>
        ) : (
          <>
            {current.id === "inbox" && (
              <InboxView
                state={state}
                needs={needs}
                busy={busy}
                go={go}
                admin={admin}
                showTasks={showTasks}
                open={showTask}
                act={act}
                more={() => loadMore("activity")}
              />
            )}
            {current.id === "tasks" && (
              <TasksView
                key={visit}
                state={state}
                open={showTask}
                more={() => loadMore("tasks")}
              />
            )}
            {current.id === "chat" && (
              <ChatView
                key={visit}
                state={state}
                request={request}
                open={showTask}
                settings={() => go("groups")}
              />
            )}
            {current.id === "groups" && (
              <GroupsView
                state={state}
                busy={busy}
                run={run}
                request={request}
              />
            )}
            {current.id === "projects" && (
              <ProjectsView
                state={state}
                busy={busy}
                run={run}
                request={request}
                edit={setProject}
              />
            )}
            {current.id === "system" && (
              <SystemView state={state} request={request} go={go} />
            )}
            {current.id === "members" && (
              <MembersView
                request={request}
                run={run}
                busy={busy}
                me={user.login}
              />
            )}
            {current.id === "settings" && (
              <SettingsView
                state={state}
                busy={busy}
                run={run}
                request={request}
                account={account}
                reload={() => loadAccount(true)}
              />
            )}
          </>
        )}
      </main>
      {toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={cn(
            "fixed bottom-24 left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg border bg-popover py-2.5 pr-2 pl-3.5 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 md:bottom-6",
            toast.error && "border-danger/50 bg-danger-soft text-danger",
          )}
        >
          {toast.error ? (
            <AlertCircle className="size-4 shrink-0" />
          ) : (
            <CircleCheck className="size-4 shrink-0 text-good" />
          )}
          <span className="min-w-0 [overflow-wrap:anywhere]">{toast.text}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="關閉"
            onClick={() => setToast(null)}
          >
            <X />
          </Button>
        </div>
      )}
      {selected && state && (
        <TaskDrawer
          key={selected.task.id}
          detail={selected}
          state={state}
          busy={busy}
          admin={admin}
          close={() => guard(closeTask, { prefixes: ["task"] })}
          go={go}
          act={act}
          open={showTask}
          followup={(task, text) =>
            run(async () => {
              const created = await request<{ id: string; status: string }>(
                `/api/tasks/${task.id}/followup`,
                "POST",
                { text },
              );
              await openTask(created.id);
            }, "已送出追問")
          }
        />
      )}
      {project && (
        <Sheet
          open
          onOpenChange={(o) =>
            !o && guard(() => setProject(null), { prefixes: ["project"] })
          }
        >
          <SheetContent className="sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>{project.id ? "編輯專案" : "新增專案"}</SheetTitle>
            </SheetHeader>
            <ProjectForm
              project={project}
              busy={busy}
              request={request}
              save={(p) =>
                run(async () => {
                  await request(
                    project.id
                      ? `/api/projects/${project.id}`
                      : "/api/projects",
                    project.id ? "PUT" : "POST",
                    p,
                  );
                  setProject(null);
                }, "專案已儲存")
              }
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

const flow = [
  [MessageSquare, "群組對話", "在 LINE 群組直接提需求"],
  [Brain, "AI 整理與分派", "合併零碎訊息、判斷要改哪個專案"],
  [Bot, "Codex 開發", "在隔離容器修改、測試、截圖驗收"],
  [GitPullRequest, "你來合併", "審閱 PR，一鍵決定是否上線"],
] as const;

function Login({ configured, error }: { configured: boolean; error: string }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden border-r bg-sidebar p-12 lg:flex lg:flex-col">
        <div className="flex items-center gap-2.5">
          <Wordmark />
        </div>
        <div className="my-auto flex max-w-md flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            LINE 群組需求 → GitHub PR
          </h2>
          <ol className="flex flex-col divide-y border-y text-sm">
            {flow.map(([, label, hint], i) => (
              <li key={label} className="flex gap-4 py-3">
                <span className="w-4 text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="flex flex-col">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground">{hint}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="text-xs text-muted-foreground">
          修改程式先確認目標專案，再於隔離容器執行；查詢有依據才自動處理。
        </p>
      </section>
      <section className="grid place-items-center px-6 py-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex items-center gap-2.5 lg:hidden">
            <Wordmark />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              登入控制台
            </h1>
            <p className="text-sm text-muted-foreground">
              在 LINE 群組提需求，AI 整理成任務並交給 Codex 開發。
              你只需要做決定。
            </p>
          </div>
          {error && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button
            size="lg"
            asChild
            disabled={!configured}
            className={cn(
              "w-full",
              !configured && "pointer-events-none opacity-50",
            )}
          >
            <a
              href={configured ? "/auth/github" : undefined}
              onClick={() => {
                try {
                  sessionStorage.setItem(
                    returnKey,
                    location.pathname + location.search,
                  );
                } catch {
                  // 無法保存時登入後回到首頁。
                }
              }}
            >
              <GithubMark /> 使用 GitHub 登入 <ArrowRight />
            </a>
          </Button>
          {!configured ? (
            <p className="text-sm text-muted-foreground">
              尚未完成 GitHub App 設定。請先執行{" "}
              <code className="rounded bg-muted px-1">npm run setup</code>。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              只有擁有者與成員名單上的 GitHub 帳號可以登入。
            </p>
          )}
          <ol className="flex flex-col gap-2 lg:hidden">
            {flow.map(([Icon, label]) => (
              <li
                key={label}
                className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
              >
                <Icon className="size-4 text-muted-foreground" /> {label}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-4">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

type QuotaProps = {
  settings: Settings;
  usage: State["usage"];
  account: Account | null | string;
};

// 訂閱模式顯示剩餘額度；API 模式顯示今日花費占每日預算的比例。
function quotaLeft({ settings: s, usage, account }: QuotaProps) {
  const tight =
    typeof account === "object" && account
      ? Math.max(
          0,
          ...account.limits.flatMap((l) => l.windows.map((w) => w.usedPercent)),
        )
      : null;
  return s.ai_mode === "api"
    ? Math.max(0, 100 - (usage.spent / s.daily_budget) * 100)
    : tight === null
      ? null
      : Math.max(0, 100 - tight);
}

// 模式、剩餘額度與今日用量；桌面側欄與手機「更多」選單共用。
function QuotaLines(props: QuotaProps) {
  const { settings: s, usage } = props;
  const left = quotaLeft(props);
  return (
    <>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {s.ai_mode === "api" ? "API 模式" : "ChatGPT 訂閱"}
        </span>
        {left !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            剩 {Math.round(left)}%
          </span>
        )}
      </span>
      {left !== null && (
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              left < 15 ? "bg-danger" : left < 40 ? "bg-warn" : "bg-brand",
            )}
            style={{ width: `${left}%` }}
          />
        </span>
      )}
      <span className="truncate text-xs text-muted-foreground">
        {s.ai_mode === "api"
          ? `今日 ${cash(usage.spent)} / ${cash(s.daily_budget)}`
          : `今日已執行 ${usage.runs_today} / ${s.daily_runs} 次`}
      </span>
    </>
  );
}

function ModeSummary({ open, ...quota }: QuotaProps & { open?: () => void }) {
  // 一般成員進不了設定頁，只顯示用量、不可點。
  if (!open)
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5">
        <QuotaLines {...quota} />
      </div>
    );
  return (
    <button
      type="button"
      onClick={open}
      title="查看額度與 AI 設定"
      className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:border-brand/40"
    >
      <QuotaLines {...quota} />
    </button>
  );
}
