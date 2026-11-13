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
