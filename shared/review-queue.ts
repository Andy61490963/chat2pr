import { fixPageLabels, parseFailure, primaryFix } from "./failure-text.js";
import type { PickList } from "./pick-list.js";
import {
  inboxStatusLabels,
  pickListLabels,
  taskClarificationLabels,
} from "./status-glossary.js";
import { taskListTitle } from "./task-title.js";
import type { ChatPlatformId, Group, Task } from "./types.js";

type ReviewTask = Pick<
  Task,
  | "id"
  | "title"
  | "summary"
  | "group_id"
  | "status"
  | "mode"
  | "question"
  | "project_id"
  | "suggestions"
  | "missing"
  | "last_error"
  | "created_at"
  | "updated_at"
>;

export type ReviewItem = {
  kind: "task" | "pickList";
  id: string;
  title: string;
  group: string;
  platform: ChatPlatformId | null;
  waitingSince: string | null;
  status: string;
};

export type ReviewSort = "oldest" | "newest";

export const pickListReviewId = (id: string) => `list-${id}`;

export function reviewTaskStatus(task: ReviewTask, admin: boolean): string {
  if (task.status === "awaiting_approval") {
    if (task.question) return inboxStatusLabels.answer;
    if (!task.project_id) return inboxStatusLabels.chooseProject;
    if (task.suggestions.length) return inboxStatusLabels.chooseOption;
    if (task.missing.length) return inboxStatusLabels.amend;
    return task.mode === "change"
      ? inboxStatusLabels.approveChange
      : inboxStatusLabels.review;
  }
  const fix = primaryFix(parseFailure(task.last_error));
  if (fix.kind === "page" && admin)
    return inboxStatusLabels.fix(fixPageLabels[fix.page]);
  if (fix.kind === "amend")
    return inboxStatusLabels.fix(taskClarificationLabels.amend);
  return inboxStatusLabels.fix(
    fix.kind === "retry"
      ? inboxStatusLabels.retry
      : inboxStatusLabels.viewFailure,
  );
}

export function reviewItems(
  needs: readonly ReviewTask[],
  pickLists: readonly PickList[],
  groups: readonly Pick<Group, "id" | "name" | "platform">[],
  admin: boolean,
): ReviewItem[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const groupFields = (id: string) => ({
    group: byId.get(id)?.name || "未命名群組",
    platform: byId.get(id)?.platform ?? null,
  });
  return [
    ...needs.map((task): ReviewItem => ({
      kind: "task",
      id: task.id,
      title: taskListTitle(task),
      ...groupFields(task.group_id),
      waitingSince:
        task.status === "failed" ? task.updated_at : task.created_at,
      status: reviewTaskStatus(task, admin),
    })),
    ...pickLists.map((list): ReviewItem => ({
      kind: "pickList",
      id: pickListReviewId(list.id),
      title: list.items[0]
        ? `${pickListLabels.pending}：${list.items[0].title}`
        : pickListLabels.pending,
      ...groupFields(list.groupId),
      // 看板未收到清單建立時間，清單之間沿用伺服器的建立順序。
      waitingSince: null,
      status: inboxStatusLabels.chooseTasks,
    })),
  ];
}

export function sortReviewItems(
  items: readonly ReviewItem[],
  sort: ReviewSort,
) {
  const dated = items.filter(
    (item): item is ReviewItem & { waitingSince: string } =>
      item.waitingSince !== null,
  );
  const undated = items.filter((item) => item.waitingSince === null);
  const direction = sort === "oldest" ? 1 : -1;
  dated.sort(
    (a, b) =>
      direction * (Date.parse(a.waitingSince) - Date.parse(b.waitingSince)),
  );
  return [...dated, ...(sort === "oldest" ? undated : undated.reverse())];
}

export function nextReviewItem(
  items: readonly ReviewItem[],
  currentId: string,
) {
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return null;
  return items[index + 1] ?? items[index - 1] ?? null;
}
