export interface StuckTask {
  taskId: string;
  title: string;
  reason: string;
  actionLabel: string;
  target: "task" | "system";
}
