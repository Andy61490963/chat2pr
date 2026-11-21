import { taskGroups } from "./types.js";

export const taskStatusFilters = {
  todo: taskGroups.attention,
  waiting: taskGroups.waiting,
  moving: taskGroups.moving,
  ready: taskGroups.ready,
};

export type TaskStatusFilter = keyof typeof taskStatusFilters;
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

export function taskListQuery(
  filter: TaskStatusFilter | "closed",
  task?: string,
) {
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  params.set("filter", filter === "closed" ? "closed" : "active");
  if (filter !== "closed") params.set("status", filter);
  return params;
}
