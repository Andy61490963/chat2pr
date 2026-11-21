import {
  projectLabels,
  statusLabels,
  taskStationStatusLabels,
} from "../../shared/status-glossary.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellRing,
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  FolderCheck,
  FolderX,
  GitPullRequest,
  HardDrive,
  Hourglass,
  MessageSquareText,
  PlugZap,
  Undo2,
  Unplug,
  UserMinus,
  UserPlus,
} from "lucide-react";
import {
  notificationTarget,
  notificationTaskFilter,
  projectNoticeTab,
  type NotificationView,
} from "../../shared/notifications.js";
import type { TaskStatusFilter } from "../../shared/task-list.js";
import { LINE_QUOTA } from "../../shared/line-quota.js";
import { taskListTitle } from "../../shared/task-title.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Task } from "../../shared/types.js";
import { type Request, ago, StationTrack } from "./shared";

export type Alert = {
  id: string;
  task_id: string | null;
  project_id?: string | null;
  kind: string;
  text: string;
  created_at: string;
  title: string | null;
  disposition?: "inbox" | "action" | "result" | "resolved";
};

const needsAction = (a: Alert) =>
  a.disposition === "inbox" || a.disposition === "action";

const kinds: Record<
  string,
  { icon: typeof Bell; tone: string; label: string }
> = {
  approval: {
    icon: CircleHelp,
    tone: "text-warn",
    label: taskStationStatusLabels.decision,
  },
  group_question: { icon: CircleHelp, tone: "text-warn", label: "AI 等你回答" },
  project_input: { icon: CircleHelp, tone: "text-warn", label: "專案等你補充" },
  input_required: { icon: CircleHelp, tone: "text-warn", label: "AI 等你回答" },
  failed: {
    icon: CircleAlert,
    tone: "text-danger",
    label: statusLabels.failed,
  },
  ready: {
    icon: GitPullRequest,
    tone: "text-good",
    label: taskStationStatusLabels.ready,
  },
  answered: { icon: MessageSquareText, tone: "text-good", label: "查詢已回覆" },
  no_changes: { icon: MessageSquareText, tone: "text-good", label: "無需修改" },
  budget: { icon: Hourglass, tone: "text-warn", label: "額度用完" },
  unsend: { icon: Undo2, tone: "text-warn", label: "來源已撤回" },
  interrupted: { icon: CircleAlert, tone: "text-danger", label: "執行中斷" },
  publish_race: {
    icon: CircleAlert,
    tone: "text-warn",
    label: "PR 需人工確認",
  },
  risk: { icon: CircleHelp, tone: "text-warn", label: "修改需要審核" },
  adopt: { icon: CircleCheck, tone: "text-good", label: "已採用方案" },
  triage: { icon: CircleAlert, tone: "text-danger", label: "需求辨識失敗" },
  knowledge: { icon: BookOpen, tone: "text-good", label: "專案記憶" },
  repo_missing: {
    icon: FolderX,
    tone: "text-danger",
    label: projectLabels.missing,
  },
  repo_found: {
    icon: FolderCheck,
    tone: "text-good",
    label: "儲存庫已接回",
  },
  ci: { icon: CircleAlert, tone: "text-danger", label: "GitHub 檢查失敗" },
  group_left: {
    icon: UserMinus,
    tone: "text-danger",
    label: "機器人已離開群組",
  },
  group_new: { icon: UserPlus, tone: "text-warn", label: "群組等你啟用" },
  service_down: { icon: Unplug, tone: "text-danger", label: "服務異常" },
  service_up: { icon: PlugZap, tone: "text-good", label: "服務已恢復" },
  disk_low: {
    icon: HardDrive,
    tone: "text-danger",
    label: "Docker 磁碟空間不足",
  },
  line_backlog: {
    icon: Unplug,
    tone: "text-warn",
    label: "LINE 通知未送出",
  },
  disk_ok: {
    icon: HardDrive,
    tone: "text-good",
    label: "Docker 磁碟空間已恢復",
  },
};
const kindOf = (k: string) =>
  kinds[k] ?? { icon: Bell, tone: "text-muted-foreground", label: "通知" };

// 桌面通知只是個人偏好，存在瀏覽器；讀寫失敗時不推播。
const desktopKey = "agentflow-desktop-alerts";
const desktopEnabled = () => {
  try {
    return (
      localStorage.getItem(desktopKey) === "on" &&
      "Notification" in window &&
      Notification.permission === "granted"
    );
  } catch {
    return false;
  }
};

export function AlertBell({
  alerts: all,
  inboxTasks,
  inboxCount,
  tasks,
  seenAt,
  request,
  open: openTask,
  openView,
  onCloseAutoFocus,
}: {
  alerts: Alert[];
  inboxTasks: Task[];
  inboxCount: number;
  tasks: Task[];
  seenAt: string | null;
  request: Request;
  open: (id: string, filter?: TaskStatusFilter) => unknown;
  // 只有管理者看得到專案、群組與設定頁；沒給就不可點。
  openView?: (
    view: NotificationView,
    projectId?: string | null,
    tab?: string,
  ) => unknown;
  /** 選單關閉時的焦點處理；換頁後由看板把焦點移到頁面標題。 */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  // 跟任務有關的通知開任務；其餘帶去能處理它的頁面（專案、群組或設定）。
  const follow = (a: Alert) => {
    const target = notificationTarget(a, !!openView);
    if ("note" in target) return;
    setMenuOpen(false);
    if ("task" in target)
      void openTask(target.task, notificationTaskFilter(a.kind));
    else void openView?.(target.view, a.project_id, projectNoticeTab(a.kind));
  };
  // 推播額度用完的提示由伺服器依 service_health 附上，固定放在清單頂端，不算未讀、不跳桌面通知。
  const quota = all.find((a) => a.kind === LINE_QUOTA);
  // 只在清單真的變了才換新陣列，下面的桌面通知 effect 才不會每次重繪都跑。
  const alerts = useMemo(() => all.filter((a) => a.kind !== LINE_QUOTA), [all]);
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const [seen, setSeen] = useState(seenAt);
  const [menuOpen, setMenuOpen] = useState(false);
  const [desktop, setDesktop] = useState(desktopEnabled);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => setSeen(seenAt), [seenAt]);
  const unreadResults = new Set(
    alerts
      .filter(
        (a) =>
          a.disposition === "result" &&
          (!seen || new Date(a.created_at) > new Date(seen)),
      )
      .map((a) => a.id),
  );
  const actions = alerts.filter(needsAction);
  const covered = new Set(actions.map((a) => a.task_id));
  // 舊版回應沒有分類時，只沿用與目前待處理狀態相符的通知文字。
  const legacyByTask = new Map<string, Alert>();
  for (const a of alerts) {
    if (!a.disposition && a.task_id && !legacyByTask.has(a.task_id)) {
      const task = tasksById.get(a.task_id);
      if (
        (task?.status === "failed" && a.kind === "failed") ||
        (task?.status === "awaiting_approval" && a.kind === "approval")
      )
        legacyByTask.set(a.task_id, a);
    }
  }
  // 任務可能沒有留下通知，仍可從鈴鐺前往收件匣列出的待處理任務。
  const unlisted: Alert[] = inboxTasks
    .filter((t) => !covered.has(t.id))
    .map((t) => {
      const legacy = legacyByTask.get(t.id);
      return {
        id: legacy?.id ?? `inbox:${t.id}`,
        task_id: t.id,
        kind: legacy?.kind ?? (t.status === "failed" ? "failed" : "approval"),
        text: legacy?.text ?? "請到任務詳情確認下一步。",
        created_at: legacy?.created_at ?? t.updated_at,
        title: t.title,
        disposition: "inbox",
      };
    });
  const unlistedIds = new Set(unlisted.map((a) => a.id));
  const menuAlerts = [
    ...actions,
    ...unlisted,
    ...alerts.filter((a) => !needsAction(a) && !unlistedIds.has(a.id)),
  ];
  const unread =
    inboxCount +
    actions.filter((a) => a.disposition === "action").length +
    unreadResults.size;
  // 看板開著時，新通知以瀏覽器桌面通知推播（第一次載入的舊通知不推）。
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(alerts.map((a) => a.id));
      return;
    }
    for (const a of alerts) {
      if (known.current.has(a.id)) continue;
      known.current.add(a.id);
      if (a.disposition !== "resolved" && desktop && desktopEnabled()) {
        const n = new Notification(`chat2pr：${kindOf(a.kind).label}`, {
          body: a.title ? `${a.title}\n${a.text}` : a.text,
          tag: a.id,
        });
        n.onclick = () => {
          window.focus();
          follow(a);
        };
      }
    }
  }, [alerts, desktop, openTask]);
  const markSeen = () => {
    if (!unreadResults.size) return;
    setSeen(new Date().toISOString());
    void request("/api/alerts/seen", "POST").catch(() => {});
  };
  const toggleDesktop = async () => {
    if (!("Notification" in window)) return;
    if (desktop) {
      setDesktop(false);
      try {
        localStorage.setItem(desktopKey, "off");
      } catch {
        // 無法保存時只影響這次瀏覽。
      }
      return;
    }
    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted") return;
    try {
      localStorage.setItem(desktopKey, "on");
    } catch {
      // 無法保存時只影響這次瀏覽。
    }
    setDesktop(true);
  };
  return (
    <DropdownMenu
      modal={false}
      open={menuOpen}
      onOpenChange={(o) => {
        setMenuOpen(o);
        if (o) markSeen();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={unread ? `通知，${unread} 則未讀` : "通知"}
          title="通知"
          className="relative"
        >
          {unread ? <BellRing /> : <Bell />}
          {unread > 0 && (
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-danger-soft tabular-nums">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">通知</span>
          {"Notification" in window && (
            // 選單項目才能用方向鍵選到；切換後選單保持開著。
            <DropdownMenuItem
              className="h-7 px-2 text-xs text-muted-foreground focus:bg-muted/60 focus:text-foreground"
              onSelect={(e) => {
                e.preventDefault();
                void toggleDesktop();
              }}
            >
              {desktop ? "關閉桌面通知" : "開啟桌面通知"}
            </DropdownMenuItem>
          )}
        </div>
        {quota && (
          <p
            role="status"
            className="flex gap-2 border-b bg-warn-soft px-3 py-2 text-xs text-warn"
          >
            <Unplug className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {quota.text}
            </span>
          </p>
        )}
        {/* 每則通知都是選單項目：鍵盤開啟鈴鐺後方向鍵可選、Enter 開啟。 */}
        <div className="max-h-[min(26rem,calc(var(--radix-dropdown-menu-content-available-height)-5rem))] overflow-y-auto">
          {menuAlerts.length ? (
            menuAlerts.map((a) => {
              const k = kindOf(a.kind);
              const Icon = k.icon;
              const task = a.task_id ? tasksById.get(a.task_id) : undefined;
              const useTaskStatus =
                (a.kind === "approval" &&
                  task?.status === "awaiting_approval") ||
                (a.kind === "failed" && task?.status === "failed") ||
                (a.kind === "ready" && task?.status === "ready");
              const action = needsAction(a);
              const isNew = action || unreadResults.has(a.id);
              // 不能前往時仍可聚焦（讀得到內容），但說明為什麼點了沒反應。
              const t = notificationTarget(a, !!openView);
              const why = "note" in t ? t.note : null;
              const target = !why;
              return (
                <DropdownMenuItem
                  key={a.id}
                  aria-disabled={target ? undefined : "true"}
                  onSelect={(e) => {
                    if (!target) {
                      e.preventDefault();
                      return;
                    }
                    follow(a);
                  }}
                  className={cn(
                    "w-full items-start gap-3 rounded-none border-b px-3 py-2.5 text-left last:border-0 focus:bg-muted/60 focus:text-foreground",
                    target &&
                      "cursor-pointer transition-colors hover:bg-muted/50",
                    isNew && "bg-muted/40",
                    "work-touch",
                  )}
                >
                  <Icon className={cn("mt-0.5 size-4 shrink-0", k.tone)} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      {!task && <span>{k.label}</span>}
                      <span className="tabular-nums">{ago(a.created_at)}</span>
                    </span>
                    {a.title && (
                      <span className="truncate text-sm font-medium">
                        {task ? taskListTitle(task) : a.title}
                      </span>
                    )}
                    <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {a.text}
                    </span>
                    {task && (
                      <StationTrack
                        task={task}
                        statusLabel={useTaskStatus ? undefined : k.label}
                      />
                    )}
                    {why && (
                      <span className="text-[11px] text-muted-foreground">
                        {why}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              你還沒有通知，等你處理的任務和完成結果會顯示在這裡。
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
