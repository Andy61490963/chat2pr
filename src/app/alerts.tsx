import { useEffect, useRef, useState } from "react";
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
  Hourglass,
  MessageSquareText,
  PlugZap,
  Undo2,
  Unplug,
  UserMinus,
  UserPlus,
} from "lucide-react";
import {
  notificationView,
  type NotificationView,
} from "../../shared/notifications.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { type Request, ago } from "./shared";

export type Alert = {
  id: string;
  task_id: string | null;
  kind: string;
  text: string;
  created_at: string;
  title: string | null;
};

const kinds: Record<
  string,
  { icon: typeof Bell; tone: string; label: string }
> = {
  approval: { icon: CircleHelp, tone: "text-warn", label: "等你審核" },
  project_input: { icon: CircleHelp, tone: "text-warn", label: "專案等你補充" },
  input_required: { icon: CircleHelp, tone: "text-warn", label: "AI 等你回答" },
  failed: { icon: CircleAlert, tone: "text-danger", label: "需要處理" },
  ready: { icon: GitPullRequest, tone: "text-good", label: "PR 已完成" },
  answered: { icon: MessageSquareText, tone: "text-good", label: "查詢已回覆" },
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
    label: "找不到儲存庫",
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
  alerts,
  seenAt,
  request,
  open: openTask,
  openView,
}: {
  alerts: Alert[];
  seenAt: string | null;
  request: Request;
  open: (id: string) => unknown;
  // 只有管理者看得到專案、群組與設定頁；沒給就不可點。
  openView?: (view: NotificationView) => unknown;
}) {
  // 跟任務有關的通知開任務；其餘帶去能處理它的頁面（專案、群組或設定）。
  const follow = (a: Alert) => {
    setMenuOpen(false);
    const view = notificationView(a.kind);
    if (a.task_id) void openTask(a.task_id);
    else if (view) void openView?.(view);
  };
  const [seen, setSeen] = useState(seenAt);
  const [menuOpen, setMenuOpen] = useState(false);
  const [desktop, setDesktop] = useState(desktopEnabled);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => setSeen(seenAt), [seenAt]);
  const unread = alerts.filter(
    (a) => !seen || new Date(a.created_at) > new Date(seen),
  );
  // 看板開著時，新通知以瀏覽器桌面通知推播（第一次載入的舊通知不推）。
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(alerts.map((a) => a.id));
      return;
    }
    for (const a of alerts) {
      if (known.current.has(a.id)) continue;
      known.current.add(a.id);
      if (desktop && desktopEnabled()) {
        const n = new Notification(`AgentFlow：${kindOf(a.kind).label}`, {
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
    if (!unread.length) return;
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
          aria-label={unread.length ? `通知，${unread.length} 則未讀` : "通知"}
          title="通知"
          className="relative"
        >
          {unread.length ? <BellRing /> : <Bell />}
          {unread.length > 0 && (
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-medium">通知</span>
          {"Notification" in window && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={(e) => {
                e.preventDefault();
                void toggleDesktop();
              }}
            >
              {desktop ? "關閉桌面通知" : "開啟桌面通知"}
            </Button>
          )}
        </div>
        <ul className="max-h-[26rem] overflow-y-auto">
          {alerts.length ? (
            alerts.map((a) => {
              const k = kindOf(a.kind);
              const Icon = k.icon;
              const isNew = !!unread.find((u) => u.id === a.id);
              return (
                <li key={a.id}>
                  <button
                    className={cn(
                      "flex w-full gap-3 border-b px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-muted/50",
                      isNew && "bg-brand-soft/40",
                    )}
                    onClick={() => follow(a)}
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", k.tone)} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">
                        {k.label} · {ago(a.created_at)}
                      </span>
                      {a.title && (
                        <span className="truncate text-sm font-medium">
                          {a.title}
                        </span>
                      )}
                      <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {a.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          ) : (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              還沒有通知。
            </li>
          )}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
