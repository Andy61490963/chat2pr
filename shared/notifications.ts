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
  | { view: NotificationView }
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
  if (view && canOpenViews) return { view };
  return { note: view ? "由管理者到看板處理" : "僅供參考" };
}
