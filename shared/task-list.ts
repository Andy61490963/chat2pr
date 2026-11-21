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
