import { taskListQuery, type TaskStatusFilter } from "./task-list.js";

export type NotificationView =
  "projects" | "groups" | "settings" | "checks" | "system";

/** 沒有對應任務的通知要帶管理者去哪一頁；看板鈴鐺與 LINE 私訊連結共用。 */
export function notificationView(kind: string): NotificationView | null {
  if (kind.startsWith("repo_") || kind.startsWith("project_"))
    return "projects";
  if (kind === "check" || kind === "group_check") return "checks";
  if (kind === "triage" || kind.startsWith("group_")) return "groups";
  if (kind.startsWith("service_")) return "settings";
  if (kind.startsWith("disk_")) return "system";
  return null;
}

export type NotificationTarget =
  | { task: string }
  | { view: Exclude<NotificationView, "system"> }
  | { view: "system"; tab: "disk" }
  | { note: "由管理者到看板處理" | "僅供參考" };

/**
 * 鈴鐺裡一則通知按下去會去哪：有任務開任務，否則到能處理它的頁面；
 * 一般成員看不到管理頁，或通知本身只是告知時，回一句說明，讓畫面講清楚為什麼點了沒反應。
 */
export function notificationTarget(
  n: { task_id: string | null; kind: string },
  canOpenViews: boolean,
): NotificationTarget {
  if (n.task_id) return { task: n.task_id };
  const view = notificationView(n.kind);
  if (view && canOpenViews)
    return view === "system" ? { view, tab: "disk" } : { view };
  return { note: view ? "由管理者到看板處理" : "僅供參考" };
}

export function projectNoticeTab(kind: string) {
  return kind === "repo_missing" ? "overview" : "environment";
}

export function notificationTaskFilter(
  kind: string,
): TaskStatusFilter | undefined {
  switch (kind) {
    case "approval":
    case "risk":
    case "input_required":
    case "group_received":
    case "group_question":
    case "failed":
    case "group_failed":
    case "interrupted":
      return "todo";
    case "ready":
    case "group_ready":
    case "ci":
      return "ready";
    case "budget":
      return "waiting";
  }
}

/** 管理者點 LINE 私訊後，沿用看板鈴鐺的目標。 */
export function notificationPath(n: {
  kind: string;
  task_id: string | null;
  project_id?: string | null;
}) {
  if (n.task_id) {
    const filter = notificationTaskFilter(n.kind);
    return `tasks?${filter ? taskListQuery(filter, n.task_id) : new URLSearchParams({ task: n.task_id })}`;
  }
  const target = notificationTarget(n, true);
  if (!("view" in target)) return "";
  const { view } = target;
  if (view === "system")
    return `system?${new URLSearchParams({ tab: target.tab })}`;
  if (view === "projects" && n.project_id)
    return (
      "projects?" +
      new URLSearchParams({
        project: n.project_id,
        tab: projectNoticeTab(n.kind),
      })
    );
  return view;
}
