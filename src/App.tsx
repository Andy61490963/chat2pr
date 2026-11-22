import { MemoryOverview } from "./app/memory-overview";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BellOff,
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
  MemoryStick,
  MessageSquare,
  RefreshCw,
  Server,
  Activity,
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
import type {
  Action,
  EndTasksResult,
  Project,
  Settings,
  Task,
} from "../shared/types.js";
import { LINE_QUOTA } from "../shared/line-quota.js";
import { groupPageText } from "../shared/status-glossary.js";
import { taskListQuery, type TaskListDestination } from "../shared/task-list.js";
import {
  reservedQuotaHold,
  subscriptionGateName,
  subscriptionQuotaHold,
} from "../shared/subscription-quota.js";
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
import { InboxView, type TaskDrawerAction } from "./app/inbox";
import { ProjectForm, ProjectsView } from "./app/projects";
import { saveProject } from "./app/project-form";
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
  countOf,
  Initials,
  memoryHold,
  message,
} from "./app/shared";
import { TaskDrawer } from "./app/task-drawer";
import { TasksView } from "./app/tasks";
import { SystemView } from "./app/system";
import {
  defaultSystemTab,
  readSystemTab,
  type SystemTab,
} from "../shared/system-tabs.js";
import {
  defaultSettingsTab,
  migrateSettingsHash,
  readSettingsTab,
  settingsTabFromUrl,
  type SettingsTab,
} from "../shared/settings-tabs.js";
import {
  defaultProjectTab,
  projectFromUrl,
  readProjectTab,
  type ProjectLocation,
} from "../shared/project-tabs.js";
import { ChecksView } from "./app/checks";
import { MembersView } from "./app/members";
import { AlertBell } from "./app/alerts";
import { PageNotices } from "./app/page-notices";
import {
  expiredMessage,
  probeService,
  readApiResponse,
  SessionExpiredError,
} from "./app/api-response";
import { dispatchStatus } from "./app/dispatch-status";
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
  },
  {
    id: "groups",
    label: "群組",
    icon: UsersRound,
    section: "管理",
    hint: groupPageText.subtitle,
  },
  {
    id: "projects",
    label: "專案",
    icon: FolderGit2,
    section: "管理",
    hint: "每個專案對應一個 GitHub 儲存庫，說明寫清楚能讓 AI 正確分派",
  },
  {
    id: "checks",
    label: "定期檢查",
    icon: Activity,
    section: "管理",
    hint: "定期檢查設備、服務或資料，狀態改變時在群組通知",
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

// 每個頁面有自己的網址，重新整理、上一頁與分享連結都會回到同一處。
const viewPaths: Record<View, string> = {
  inbox: "/",
  tasks: "/tasks",
  chat: "/chat",
  groups: "/groups",
  projects: "/projects",
  system: "/system",
  checks: "/checks",
  members: "/members",
  settings: "/settings",
};
const viewFromPath = (path: string): View =>
  (Object.entries(viewPaths) as [View, string][]).find(
    ([, p]) => p === (path.replace(/\/+$/, "") || "/"),
  )?.[0] ?? "inbox";
const writeUrl = (view: View, task: string | null, push = true) => {
  // 同一頁開關任務詳情時保留篩選等參數；換頁就清掉。
  const q = new URLSearchParams(
    viewPaths[view] === (location.pathname.replace(/\/+$/, "") || "/")
      ? location.search
      : "",
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
  notifications: "LINE 推播（群組回覆與私訊）",
};
// 登入前所在的網址：GitHub 登入回來後回到這裡（例如 LINE 通知裡的任務連結）。
const returnKey = "agentflow-return";

export function App() {
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname)),
    [systemTab, setSystemTab] = useState(() =>
      readSystemTab(new URLSearchParams(location.search).get("tab")),
    ),
    [settingsTab, setSettingsTab] = useState(() =>
      settingsTabFromUrl(new URL(location.href)),
    ),
    [lineQuotaHelpOpen, setLineQuotaHelpOpen] = useState(false),
    [state, setState] = useState<State | null>(null),
    [user, setUser] = useState<{
      csrf: string;
      login: string;
      role?: "admin" | "member";
      owner?: boolean;
    } | null>(null),
    // null：連不上服務（通道或服務重啟中），false：服務在但還沒設定 GitHub App。
    [configured, setConfigured] = useState<boolean | null>(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    // 操作中途登入過期時顯示在登入頁的說明；主動登出不設。
    [expired, setExpired] = useState(""),
    // 失敗的提示用紅色、停留較久，才不會跟「已儲存」混在一起又一閃而過。
    [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
      null,
    ),
    [selected, setSelected] = useState<Detail | null>(null),
    [taskAfterNavigation, setTaskAfterNavigation] = useState<string | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [project, setProject] = useState<Partial<Project> | null>(null),
    [projectLocation, setProjectLocation] = useState(() =>
      projectFromUrl(new URL(location.href)),
    ),
    [bindingProjectId, setBindingProjectId] = useState<string | null>(null),
    // 每次從導覽切換頁面就加一，讓該頁丟掉上一輪的篩選、照網址重新開始。
    [visit, setVisit] = useState(0),
    [taskHistoryRevision, setTaskHistoryRevision] = useState(0),
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
  const signingOut = useRef(false);
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
      // 主動登出途中還在跑的請求回 401 是預期的，不當成「登入已失效」。
      if (response.status === 401 && !signingOut.current) {
        // 保留第一個說明：寫入失敗後緊接的重新整理（GET）不能把「操作沒有完成」蓋掉。
        setExpired((prev) => prev || expiredMessage(method));
        setUser(null);
        setState(null);
      }
      return readApiResponse(response, method);
    },
    [user],
  );
  const guard = useGuard();
  // 動態只載入最近的一部分；按「載入更多」才加大範圍。
  const activityLimit = useRef(80);
  const refresh = useCallback(async () => {
    try {
      setState(
        await request<State>(`/api/state?activity=${activityLimit.current}`),
      );
      setError("");
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }, [request]);
  // 通道停了會回 502／530 的 HTML 頁：當成暫時連不上（configured=null），
  // 登入頁給「重新連線」，不要叫使用者去執行 npm run setup。
  const connect = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const probe = await probeService<NonNullable<typeof user>>((url) =>
      fetch(url, { credentials: "same-origin", signal }),
    );
    if (signal?.aborted) return;
    if (probe.user) {
      signingOut.current = false;
      setUser(probe.user);
    }
    setConfigured(probe.configured);
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void connect(controller.signal);
    return () => controller.abort();
  }, [connect]);
  useEffect(() => {
    if (!user) return;
    let initialReadAt: number | null | undefined;
    void refresh().then((ok) => {
      initialReadAt = ok ? performance.now() : null;
    });
    const events = new EventSource("/api/events");
    events.addEventListener("update", () => void refresh());
    // 斷線幾秒內自己接回來就不打擾；持續接不上才提示畫面可能不是最新。
    let lost: ReturnType<typeof setTimeout> | undefined;
    let needsCatchUp = false;
    events.addEventListener("connected", () => {
      clearTimeout(lost);
      lost = undefined;
      setOffline(false);
      // 首次連線沿用正在讀取或五秒內取得的快照；重連則補讀斷線期間的變更。
      const initialReadIsFresh =
        initialReadAt === undefined ||
        (initialReadAt !== null && performance.now() - initialReadAt < 5000);
      if (needsCatchUp || !initialReadIsFresh) void refresh();
      needsCatchUp = true;
    });
    events.addEventListener("error", () => {
      needsCatchUp = true;
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
  // 分頁標題跟著頁面與任務走，多開分頁時分得出來；有待處理的事會顯示數量
  // （伺服器的實際數量，等待額度會自動繼續、不算在內）。
  const waiting = state
    ? countOf(state, attention) + (state.pickLists?.length ?? 0)
    : 0;
  const pageLabel = views.find((v) => v.id === view)?.label;
  const taskTitle = selected?.task.title;
  useEffect(() => {
    document.title = user
      ? `${waiting ? `(${waiting}) ` : ""}${taskTitle ?? pageLabel}｜chat2pr`
      : "chat2pr｜群組需求到 PR";
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
  // 從收件匣開啟指定表單的要求只使用一次。
  const taskAction = useRef<{ id: string; action: TaskDrawerAction } | null>(
    null,
  );
  const openTask = useCallback(
    async (id: string, push = true, action?: TaskDrawerAction) => {
      try {
        const detail = await request<Detail>(`/api/tasks/${id}`);
        taskAction.current = action ? { id, action } : null;
        setSelected(detail);
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
  const lastUrl = useRef(location.href);
  useEffect(() => {
    const migrated = migrateSettingsHash(new URL(location.href));
    if (migrated) history.replaceState(null, "", migrated);
  }, []);
  useEffect(() => {
    lastUrl.current = location.href;
  });
  // 瀏覽器上一頁／下一頁：依網址切換頁面與任務詳情。
  useEffect(() => {
    const onPop = () => {
      // 確認視窗開啟期間仍可能收到 SSE；先保存網址，避免重新渲染改寫返回位置。
      const previousUrl = lastUrl.current;
      const destination = new URL(location.href);
      const previous = new URL(previousUrl);
      const nextView = viewFromPath(destination.pathname);
      const migrated = migrateSettingsHash(destination);
      // 設定頁內切換分頁時，草稿仍留在掛載中的面板。
      if (
        nextView === "settings" &&
        viewFromPath(previous.pathname) === "settings" &&
        destination.searchParams.get("task") ===
          previous.searchParams.get("task")
      ) {
        if (migrated) history.replaceState(null, "", migrated);
        lastUrl.current = location.href;
        setSettingsTab(settingsTabFromUrl(destination));
        return;
      }
      guard(
        () => {
          if (migrated) history.replaceState(null, "", migrated);
          setView(nextView);
          setSystemTab(readSystemTab(destination.searchParams.get("tab")));
          setSettingsTab(settingsTabFromUrl(destination));
          setProjectLocation(projectFromUrl(destination));
          setProject(null);
          setBindingProjectId(null);
          setTaskAfterNavigation(null);
          const id = destination.searchParams.get("task");
          if (id) void openTask(id, false);
          else setSelected(null);
        },
        { cancel: () => history.pushState(null, "", previousUrl) },
      );
    };
    const onHash = () => {
      lastUrl.current = location.href;
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
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
      const destination = new URL(location.href);
      const migrated = migrateSettingsHash(destination);
      if (migrated) history.replaceState(null, "", migrated);
      setView(viewFromPath(location.pathname));
      setSystemTab(readSystemTab(destination.searchParams.get("tab")));
      setSettingsTab(settingsTabFromUrl(destination));
    }
    setProjectLocation(projectFromUrl(new URL(location.href)));
    const id = new URLSearchParams(location.search).get("task");
    if (id) void openTask(id, false);
  }, [user, openTask]);
  // 使用者從導覽換頁後把焦點移到頁面標題，讀屏與鍵盤從新頁面開頭繼續；
  // visit 只在換頁時加一，初次載入與輪詢重新整理都不搶焦點。
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (visit) heading.current?.focus({ preventScroll: true });
  }, [visit]);
  useEffect(() => {
    if (!taskAfterNavigation) return;
    setTaskAfterNavigation(null);
    // 先讓任務頁依網址套用篩選並取得焦點，再開啟詳情。
    void openTask(taskAfterNavigation, false);
  }, [taskAfterNavigation, openTask]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 12000 : 4500);
    return () => clearTimeout(t);
  }, [toast]);
  // 回傳是否成功：表單只在成功時清空輸入。請求已成功但重新整理失敗仍算成功，
  // 否則輸入留著，使用者再按一次就會重複送出（例如重複追問）。
  const run: Run = async (fn, done = "已儲存") => {
    setBusy(true);
    try {
      let toastText: string;
      try {
        const result = await fn();
        toastText = typeof done === "function" ? done(result) : done;
      } catch (e) {
        setToast({ text: message(e), error: true });
        return false;
      }
      setToast({ text: toastText });
      if (view === "tasks") setTaskHistoryRevision((n) => n + 1);
      try {
        await refresh();
      } catch {
        // refresh 自己會把錯誤顯示在畫面上；這裡不改變送出結果。
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  const act = (task: Task, action: Action, body: object = {}, done?: string) =>
    run(async () => {
      const updated = await request<Task>(
        `/api/tasks/${task.id}/actions`,
        "POST",
        {
          action,
          version: task.version,
          ...body,
        },
      );
      if (selected?.task.id === task.id) {
        if (updated.id !== task.id) await openTask(updated.id);
        else setSelected(await request<Detail>(`/api/tasks/${task.id}`));
      }
    }, done ?? "任務已更新");
  const leave = (
    v: View,
    tab?: SystemTab | SettingsTab,
    detail: ProjectLocation | null = null,
  ) => {
    setView(v);
    setSelected(null);
    setTaskAfterNavigation(null);
    // 從導覽進入一律是乾淨的頁面：不帶上一輪的篩選。
    const query = new URLSearchParams(
      detail ? { project: detail.id, tab: detail.tab } : tab ? { tab } : {},
    );
    const path = viewPaths[v] + (query.size ? `?${query}` : "");
    if (path !== location.pathname + location.search + location.hash)
      history.pushState(null, "", path);
    setProjectLocation(detail);
    setBindingProjectId(null);
    setSystemTab(v === "system" ? readSystemTab(tab ?? null) : defaultSystemTab);
    setSettingsTab(
      v === "settings" ? readSettingsTab(tab ?? null) : defaultSettingsTab,
    );
    setVisit((n) => n + 1);
    window.scrollTo({ top: 0 });
  };
  const showProject = (detail: ProjectLocation | null, push = true) => {
    const url = new URL(location.href);
    if (viewFromPath(url.pathname) !== "projects") return;
    if (detail) {
      url.searchParams.set("project", detail.id);
      url.searchParams.set("tab", detail.tab);
    } else {
      url.searchParams.delete("project");
      url.searchParams.delete("tab");
    }
    if (url.href !== location.href) {
      if (push) history.pushState(null, "", url);
      else history.replaceState(null, "", url);
      lastUrl.current = url.href;
    }
    setProjectLocation(detail);
  };
  const changeTab = (tab: SystemTab | SettingsTab) => {
    const url = new URL(location.href);
    url.searchParams.set("tab", tab);
    if (url.href !== location.href) history.pushState(null, "", url);
  };
  const changeSettingsTab = (tab: SettingsTab) => {
    changeTab(tab);
    setSettingsTab(tab);
  };
  // 換頁前先確認沒有未儲存的修改。
  const go = (v: View, projectId?: string | null, tab?: string) => {
    if (v === "settings" && view === v) {
      changeSettingsTab(readSettingsTab(tab ?? null));
      heading.current?.focus({ preventScroll: true });
      return;
    }
    const nextTab =
      tab && v === "system"
        ? readSystemTab(tab)
        : tab && v === "settings"
          ? readSettingsTab(tab)
          : undefined;
    guard(() => {
      leave(
        v,
        nextTab,
        v === "projects" && projectId
          ? { id: projectId, tab: readProjectTab(tab ?? "environment") }
          : null,
      );
    });
  };
  const changeSystemTab = (tab: SystemTab) => {
    changeTab(tab);
    setSystemTab(tab);
  };
  const startGroupBinding = (id: string) =>
    guard(() => {
      leave("groups");
      setBindingProjectId(id);
    });
  // 從選單換頁時，選單關閉會把焦點還給觸發按鈕；改送到新頁面的標題。
  const fromMenu = useRef(false);
  const goFromMenu = (v: View, projectId?: string | null, tab?: string) => {
    fromMenu.current = true;
    go(v, projectId, tab);
  };
  const headingAfterMenu = (e: Event) => {
    if (!fromMenu.current) return;
    fromMenu.current = false;
    e.preventDefault();
    heading.current?.focus({ preventScroll: true });
  };
  // 收件匣與通知直接開啟對應篩選的任務清單。
  const showTasks = (filter: TaskListDestination, taskId?: string) =>
    guard(() => {
      leave("tasks");
      history.replaceState(
        null,
        "",
        `${viewPaths.tasks}?${taskListQuery(filter, taskId)}`,
      );
      if (taskId) setTaskAfterNavigation(taskId);
    });
  // 已開著另一個任務、而且補充需求還沒送出時，先問再切換。
  const showTask = (id: string, action?: TaskDrawerAction) =>
    guard(
      () => void openTask(id, true, action),
      { prefixes: ["task"] },
    );
  const loadMoreActivity = () => {
    activityLimit.current = Math.min(activityLimit.current * 2, 2000);
    return refresh();
  };
  // 主動登出不經過 refresh：登出後再讀狀態必然 401，登入頁會誤顯示「登入已失效」。
  const signOut = async () => {
    signingOut.current = true;
    setBusy(true);
    try {
      await request("/api/logout", "POST");
    } catch (e) {
      // 工作階段本來就過期也算登出完成；其他錯誤（例如連不上）留在原畫面說明。
      if (!(e instanceof SessionExpiredError)) {
        signingOut.current = false;
        setToast({ text: message(e), error: true });
        return;
      }
    } finally {
      setBusy(false);
    }
    setSelected(null);
    setUser(null);
    setState(null);
    setError("");
    setExpired("");
  };
  const logout = () => void signOut();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 正在連線…
      </div>
    );
  if (!user)
    return (
      <Login
        configured={configured}
        notice={expired}
        retry={() => void connect()}
      />
    );
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
  // 一般成員只看得到工作區。
  const admin = user.role !== "member";
  const goneProjects = (state?.projects ?? []).filter((p) => p.repo_missing_at);
  const lineQuota = state?.health.find((h) => h.name === LINE_QUOTA && !h.ok);
  const down = (state?.health ?? []).filter(
    (h) =>
      !h.ok &&
      vital[h.name] &&
      // 額度用完時推播失敗是預期中的，由下方黃色橫幅說明，不算「連線異常」。
      !(lineQuota && h.name === "notifications") &&
      (!["codex", "openai"].includes(h.name) ||
        (h.name === "codex") === (state?.settings.ai_mode === "subscription")),
  );
  const visible = views.filter((v) => admin || v.section === "工作區");
  const current = visible.find((v) => v.id === view) ?? visible[0];
  const morePages = visible.filter((v) => v.section === "管理");
  const moreIsCurrent = current.section === "管理";
  const hostHold = state?.diskDispatchPaused
    ? "Docker 磁碟空間嚴重不足"
    : memoryHold(state);
  const reserve = state?.settings.codex_reserve_percent ?? 0;
  const accountSnapshot = typeof account === "object" ? account : null;
  const quotaCheck = state?.health.find((h) => h.name === subscriptionGateName);
  const subscriptionHold = !subscription
    ? null
    : reserve > 0 &&
        quotaCheck &&
        (!accountSnapshot ||
          Date.parse(quotaCheck.checked_at) >=
            Date.parse(accountSnapshot.checkedAt))
      ? quotaCheck.ok
        ? null
        : quotaCheck.detail
      : accountSnapshot && (reserve > 0 || accountSnapshot.allowed === false)
        ? subscriptionQuotaHold(accountSnapshot, reserve)
        : null;
  const hold = state?.settings.paused ? null : (hostHold ?? subscriptionHold);
  const holdView = hostHold ? "system" : "settings";
  const holdTab = hostHold
    ? state?.diskDispatchPaused
      ? "disk"
      : defaultSystemTab
    : undefined;
  const showServiceNotice =
    view !== "settings" || settingsTab !== "connections";
  const notices = [
    admin &&
      goneProjects.length > 0 && {
        key: [
          "projects",
          ...goneProjects.map((p) => [p.id, p.repo_missing_at]).sort(),
        ],
        visible: view !== "projects",
      },
    admin &&
      down.length > 0 && {
        key: [
          "services",
          ...down.map((h) => [h.name, h.outage_started_at]).sort(),
        ],
        visible: showServiceNotice,
      },
    (state?.settings.paused || state?.settings.triage_paused) && {
      key: state.settings.paused ? "dispatch-paused" : "triage-paused",
      visible: true,
    },
    hold && {
      key: [
        "hold",
        state?.diskDispatchPaused
          ? "disk"
          : hostHold
            ? "memory"
            : subscriptionHold,
      ],
      visible: true,
    },
    lineQuota && {
      key: [
        "line-quota",
        lineQuota.outage_started_at ?? lineQuota.checked_at?.slice(0, 7),
      ],
      visible: true,
    },
    offline && { key: "offline", visible: true },
    error && { key: "error", visible: true },
  ].filter((notice) => typeof notice === "object" && notice !== null);
  const noticeCount = notices.filter((notice) => notice.visible).length;
  const noticeIncident = notices.length
    ? JSON.stringify(notices.map((notice) => notice.key))
    : state
      ? null
      : undefined;
  const live = state && !state.settings.paused && !hold;
  const dispatch =
    state &&
    dispatchStatus({
      paused: state.settings.paused,
      triagePaused: !!state.settings.triage_paused,
      hold,
      admin,
    });
  const dispatchContent = dispatch && (
    <>
      <span
        className={cn(
          "inline-flex size-1.5 rounded-full",
          live ? "bg-good" : "bg-warn",
        )}
      />
      {dispatch.label}
    </>
  );
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
        <nav
          aria-label="看板導覽"
          className="flex justify-around md:flex-col md:justify-start md:gap-0.5"
        >
          {visible.map(({ id, label, icon: Icon, section }, i) => (
            <div key={id} className="contents">
              {section !== visible[i - 1]?.section && (
                <p
                  className={cn(
                    "hidden px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground md:block",
                    i > 0 && "md:mt-4",
                  )}
                >
                  {section}
                </p>
              )}
              {/* 不設 aria-label：名稱由文字與徽章組成，讀屏才念得到待處理數量。 */}
              <button
                aria-current={current.id === id ? "page" : undefined}
                onClick={() => go(id)}
                className={cn(
                  "relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:min-h-0 md:flex-none md:flex-row md:justify-start md:gap-3 md:rounded-md md:px-3 md:py-1.5 md:text-sm md:hover:bg-sidebar-accent",
                  current.id === id &&
                    "bg-sidebar-accent font-medium text-foreground",
                  section === "管理" && "hidden md:flex",
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
                    <span aria-hidden="true">{needs.length}</span>
                    <span className="sr-only">，{needs.length} 件待處理</span>
                  </span>
                )}
              </button>
            </div>
          ))}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                aria-current={moreIsCurrent ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:hidden",
                  moreIsCurrent &&
                    "bg-sidebar-accent font-medium text-foreground",
                )}
              >
                <Ellipsis className="size-5" />
                更多
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              className="w-60"
              onCloseAutoFocus={headingAfterMenu}
            >
              <DropdownMenuLabel className="flex items-center gap-2">
                <Initials name={user.login} />
                <span className="min-w-0 truncate">{user.login}</span>
              </DropdownMenuLabel>
              {state && (
                <DropdownMenuLabel className="flex flex-col items-start gap-0.5 font-normal">
                  <QuotaLines
                    settings={state.settings}
                    usage={state.usage}
                    account={account}
                  />
                </DropdownMenuLabel>
              )}
              <DropdownMenuSeparator />
              {morePages.map(({ id, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={id}
                  aria-current={current.id === id ? "page" : undefined}
                  className="min-h-[44px] aria-[current=page]:font-semibold"
                  onSelect={() => goFromMenu(id)}
                >
                  <Icon /> {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem className="min-h-[44px]" onSelect={logout}>
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
            "mb-7 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3",
            current.id === "chat" && "mb-4 shrink-0",
          )}
        >
          <div className="min-w-0">
            <h1
              ref={heading}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none md:text-[26px]"
            >
              {current.label}
            </h1>
            {"hint" in current && (
              <p
                className={cn(
                  "mt-0.5 text-sm text-muted-foreground",
                  current.id !== "groups" && "hidden sm:block",
                )}
              >
                {current.hint}
              </p>
            )}
          </div>
          {state && (
            <div className="flex items-center gap-1.5">
              {dispatch && "ariaLabel" in dispatch ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void togglePause()}
                  aria-label={dispatch.ariaLabel}
                  title={dispatch.title}
                  className="font-normal"
                >
                  {dispatchContent}
                </Button>
              ) : (
                // 一般成員不能切換：只顯示狀態，不做成按鈕，也不寫「點此」。
                <span
                  title={dispatch?.title}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 text-sm whitespace-nowrap dark:border-input"
                >
                  {dispatchContent}
                </span>
              )}
              <AlertBell
                alerts={state.alerts ?? []}
                inboxTasks={needs}
                inboxCount={countOf(state, attention)}
                tasks={state.tasks}
                seenAt={state.alertsSeenAt ?? null}
                request={request}
                open={(id, filter) =>
                  filter ? showTasks(filter, id) : showTask(id)
                }
                openView={admin ? goFromMenu : undefined}
                onCloseAutoFocus={headingAfterMenu}
              />
              <Button
                variant="ghost"
                size="icon"
                // 手機觸控目標至少 44px；桌面維持原尺寸。
                className="size-11 md:size-9"
                aria-label="重新整理"
                title="重新整理"
                onClick={() => {
                  if (view === "tasks") setTaskHistoryRevision((n) => n + 1);
                  void refresh();
                }}
              >
                <RefreshCw />
              </Button>
            </div>
          )}
        </header>
        <PageNotices incident={noticeIncident} count={noticeCount}>
          {admin && goneProjects.length > 0 && view !== "projects" && (
            <p
              role="alert"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm text-danger"
            >
              <FolderX className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                專案{goneProjects.map((p) => `「${p.name}」`).join("")}
                的儲存庫找不到了（可能已刪除、搬家或改名），已先停用並暫時解除群組綁定。
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => go("projects")}
              >
                查看專案
              </Button>
            </p>
          )}
          {admin && down.length > 0 && showServiceNotice && (
            <p
              role="alert"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm text-danger"
            >
              <Unplug className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {down.map((h) => vital[h.name]).join("、")}
                連線異常，恢復前相關功能會停擺。
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => go("settings", null, "connections")}
              >
                前往設定
              </Button>
            </p>
          )}
          {state && (state.settings.paused || state.settings.triage_paused) && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm"
            >
              <CirclePause className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {state.settings.paused
                  ? "派工已暫停，訊息仍會保留，你可以按「開始派工」恢復排程。"
                  : "已核准的任務照常執行，你可以在設定關閉「暫停新需求判讀」。"}
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
                  (view !== "settings" || settingsTab !== defaultSettingsTab) && (
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
          {hold && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm"
            >
              {hostHold ? (
                <MemoryStick className="size-4 shrink-0" />
              ) : (
                <CirclePause className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {hostHold
                  ? `資源不足，派工自動暫停（${hostHold}），資源恢復後會自動繼續。`
                  : hold.startsWith(reservedQuotaHold)
                    ? hold
                    : `${hold}，額度恢復後會自動繼續。`}
              </span>
              {admin &&
                (view !== holdView ||
                  (holdTab
                    ? systemTab !== holdTab
                    : settingsTab !== defaultSettingsTab)) && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => go(holdView, null, holdTab)}
                  >
                    {hostHold ? "查看系統頁" : "查看訂閱額度"}
                  </Button>
                )}
            </p>
          )}
          {lineQuota && (
            <div className="px-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-2">
                <p
                  role="status"
                  className="flex flex-[1_1_9rem] items-start gap-2 py-2"
                >
                  <BellOff
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span>LINE 本月推播額度已用完，你仍可在看板查看通知。</span>
                </p>
                <button
                  type="button"
                  aria-expanded={lineQuotaHelpOpen}
                  aria-controls="line-quota-help"
                  onClick={() => setLineQuotaHelpOpen((open) => !open)}
                  className="work-touch inline-flex items-center font-medium underline underline-offset-4"
                >
                  {lineQuotaHelpOpen ? "收起說明" : "怎麼辦"}
                </button>
              </div>
              <div
                id="line-quota-help"
                hidden={!lineQuotaHelpOpen}
                className="pb-2"
              >
                <p>
                  額度通常在下個月初重置，你可以先從任務詳情複製結果貼回群組，或在群組輸入
                  /進度 取回。
                </p>
                <p>
                  你仍會在群組收到即時確認，額度恢復後會續送仍有效的群組回覆和私訊。
                </p>
              </div>
            </div>
          )}
          {offline && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm"
            >
              <WifiOff className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                即時更新中斷了，正在重新連線；畫面可能不是最新狀態。
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void refresh()}
              >
                立即更新
              </Button>
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm text-danger"
            >
              <AlertCircle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void refresh()}
              >
                重試
              </Button>
            </p>
          )}
        </PageNotices>
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
                endTasks={(tasks, reason, notify) =>
                  run(
                    () =>
                      request<EndTasksResult>("/api/tasks/batch-end", "POST", {
                        tasks,
                        reason,
                        notify,
                      }),
                    ({ ended, skipped }) =>
                      `已結束 ${ended} 張任務，略過 ${skipped} 張狀態或需求已變更的任務。`,
                  )
                }
                resolvePickList={(list, itemIds) =>
                  run(
                    () =>
                      request<{ created: number }>(
                        `/api/pick-lists/${list.id}/resolve`,
                        "POST",
                        {
                          version: list.version,
                          itemIds,
                        },
                      ),
                    ({ created }) =>
                      created
                        ? `已建立 ${created} 張待確認任務`
                        : "已選擇全部不做，清單已結束",
                  )
                }
                more={loadMoreActivity}
              />
            )}
            {current.id === "tasks" && (
              <TasksView
                key={`${user.login}:${visit}`}
                state={state}
                open={showTask}
                request={request}
                login={user.login}
                historyRevision={taskHistoryRevision}
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
              <>
                <GroupsView
                  openSettings={() => go("settings")}
                  state={state}
                  busy={busy}
                  run={run}
                  request={request}
                  bindingProjectId={bindingProjectId}
                  finishBinding={() => setBindingProjectId(null)}
                />
                <MemoryOverview state={state} go={go} />
              </>
            )}
            {current.id === "projects" && (
              <ProjectsView
                state={state}
                busy={busy}
                run={run}
                request={request}
                edit={(p) => {
                  if (p.id) showProject(null);
                  setProject(p);
                }}
                detail={projectLocation}
                onProjectChange={showProject}
                onBindGroup={admin ? startGroupBinding : undefined}
              />
            )}
            {current.id === "checks" && (
              <ChecksView state={state} request={request} admin={admin} visit={visit} />
            )}
            {current.id === "system" && (
              <SystemView
                state={state}
                request={request}
                admin={admin}
                tab={systemTab}
                onTabChange={changeSystemTab}
              />
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
                tab={settingsTab}
                onTabChange={changeSettingsTab}
                state={state}
                busy={busy}
                run={run}
                request={request}
                account={account}
                reload={() => loadAccount(true)}
                owner={user.owner === true}
                refreshState={refresh}
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
          startAction={
            taskAction.current?.id === selected.task.id
              ? taskAction.current.action
              : undefined
          }
          actionStarted={() => (taskAction.current = null)}
          close={() => guard(closeTask, { prefixes: ["task"] })}
          go={go}
          act={act}
          open={showTask}
          followup={(task, text) =>
            run(
              async () => {
                const created = await request<{ id: string; status: string }>(
                  `/api/tasks/${task.id}/followup`,
                  "POST",
                  { text },
                );
                await openTask(created.id);
              },
              task.mode === "query"
                ? "已送出追問"
                : "已建立新的一題，等待你確認",
            )
          }
          answer={(task, text) =>
            run(async () => {
              await request(`/api/tasks/${task.id}/answer`, "POST", {
                text,
                version: task.version,
              });
              await openTask(task.id, false);
            }, "已收到回答")
          }
          relink={(task, parentId) =>
            run(async () => {
              await request(`/api/tasks/${task.id}/relink`, "POST", {
                parent_id: parentId,
                version: task.version,
              });
              await openTask(task.id, false);
            }, "已更新這一題接續的位置")
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
              save={async (p, validate) => {
                // 存好後打開該專案的詳情；選了「儲存並驗證環境」就接著排入驗證，
                // 驗證沒排上只提示原因，不讓儲存看起來失敗。
                let notice = null as { text: string; error?: boolean } | null;
                const ok = await run(async () => {
                  const result = await saveProject(
                    request,
                    project.id,
                    p,
                    validate,
                  );
                  notice = result.notice;
                  setProject(null);
                  showProject({ id: result.saved.id, tab: defaultProjectTab });
                }, "專案已儲存");
                if (ok && notice) setToast(notice);
              }}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

const flow = [
  [MessageSquare, "群組對話", "在 LINE 群組或 Discord 頻道提需求"],
  [Brain, "AI 整理與分派", "合併零碎訊息、判斷要改哪個專案"],
  [Bot, "Codex 開發", "在隔離容器修改、測試、截圖驗收"],
  [
    GitPullRequest,
    "你來合併",
    "到 GitHub 審閱並合併 PR。部署依你們的流程。",
  ],
] as const;

function Login({
  configured,
  notice,
  retry,
}: {
  /** null：連不上服務；false：服務在但尚未設定 GitHub App。 */
  configured: boolean | null;
  /** 登入過期的說明（例如剛才的操作沒有完成）。 */
  notice: string;
  retry: () => void;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden border-r bg-sidebar p-12 lg:flex lg:flex-col">
        <div className="flex items-center gap-2.5">
          <Wordmark />
        </div>
        <div className="my-auto flex max-w-md flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            從群組需求到 GitHub PR
          </h2>
          <ol className="flex flex-col divide-y border-y text-sm">
            {flow.map(([, label, hint]) => (
              <li key={label} className="flex flex-col py-3">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{hint}</span>
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
              在 LINE 群組或 Discord 頻道提需求，AI 整理成任務並交給 Codex 開發。
            </p>
          </div>
          {configured === null ? (
            <>
              <p
                role="alert"
                className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                你暫時連不上 chat2pr，服務可能正在重新啟動，請稍後再試。
              </p>
              <Button size="lg" className="w-full" onClick={retry}>
                <RefreshCw /> 重新連線
              </Button>
            </>
          ) : (
            <>
              {notice && (
                <p
                  role="status"
                  className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
                >
                  {notice}
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
                  <GithubMark /> 使用 GitHub 登入
                </a>
              </Button>
              {!configured ? (
                <p className="text-sm text-muted-foreground">
                  服務尚未完成 GitHub App 設定，請聯絡部署者執行{" "}
                  <code className="rounded bg-muted px-1">npm run setup</code>。
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  只有擁有者與成員名單上的 GitHub 帳號可以登入。
                </p>
              )}
            </>
          )}
          <ol className="flex flex-col gap-2 lg:hidden">
            {flow.map(([Icon, label, hint], index) => (
              <li
                key={label}
                className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
              >
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div>
                  <span className="font-medium">{label}</span>
                  {index === flow.length - 1 && (
                    <p className="text-muted-foreground">{hint}</p>
                  )}
                </div>
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
              left < 15 ? "bg-danger" : left < 40 ? "bg-warn" : "bg-good",
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
