import { taskGroups, type Task } from "./types.js";

const taipeiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayMs = 86_400_000;

export function mergedWeekDay(now = new Date()) {
  const { year, month, day } = Object.fromEntries(
    taipeiDate.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

/** 以臺北時間的今天與前六天為準，包含起日午夜，不包含隔日午夜。 */
export function mergedWeekBounds(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < "0001-01-08") return null;
  const midnight = new Date(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(midnight.getTime()) || mergedWeekDay(midnight) !== day)
    return null;
  return {
    since: new Date(midnight.getTime() - 6 * dayMs),
    until: new Date(midnight.getTime() + dayMs),
  };
}

export function isMergedInWeek(
  task: Pick<Task, "status" | "updated_at">,
  { since, until }: NonNullable<ReturnType<typeof mergedWeekBounds>>,
) {
  const updated = new Date(task.updated_at);
  return task.status === "merged" && updated >= since && updated < until;
}

export const taskStatusFilters = {
  todo: taskGroups.attention,
  waiting: taskGroups.waiting,
  moving: taskGroups.moving,
  ready: taskGroups.ready,
};

export type TaskStatusFilter = keyof typeof taskStatusFilters;
export type TaskListDestination =
  TaskStatusFilter | "closed" | { mergedWeek: string };
export const taskStatusFilterIds = Object.keys(
  taskStatusFilters,
) as TaskStatusFilter[];

export function countTaskFilterConditions({
  statuses,
  group,
  project,
  by,
  isHistory,
}: {
  statuses: readonly string[];
  group: string;
  project: string;
  by: string;
  isHistory: boolean;
}) {
  const statusCount = isHistory
    ? 0
    : taskStatusFilterIds.filter((id) => statuses.includes(id)).length;
  const defaultGrouping = isHistory ? "none" : "project";
  return (
    statusCount +
    Number(group !== "all") +
    Number(project !== "all") +
    Number(by !== defaultGrouping)
  );
}

export function taskListQuery(filter: TaskListDestination, task?: string) {
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (typeof filter === "object") {
    params.set("filter", "closed");
    params.set("mergedWeek", filter.mergedWeek);
  } else {
    params.set("filter", filter === "closed" ? "closed" : "active");
    if (filter !== "closed") params.set("status", filter);
  }
  return params;
}
