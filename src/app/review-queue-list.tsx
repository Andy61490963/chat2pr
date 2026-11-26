import { useId, type ReactNode } from "react";
import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";
import { parseFailure, primaryFix } from "../../shared/failure-text.js";
import type { ReviewItem, ReviewSort } from "../../shared/review-queue.js";
import { groupPlatformLabels } from "../../shared/status-glossary.js";
import type { Task } from "../../shared/types.js";
import { ago, type Detail, type State } from "./shared";

export type QuickDecision =
  | { kind: "retry"; task: Task; label: "重試" }
  | {
      kind: "approve";
      task: Task;
      label: "核准修改" | "開始查詢";
      projectName: string;
      body: {
        project_id: string;
        target_branch: string;
        config_version: number;
        binding_version: number;
      };
    };

function simpleApproval(task: Task) {
  return (
    task.status === "awaiting_approval" &&
    !task.question &&
    task.missing?.length === 0 &&
    task.suggestions?.length === 0 &&
    task.risk_reasons?.length === 0 &&
    task.pending_paths?.length === 0 &&
    !task.assumptions?.length &&
    !task.baseline_repair &&
    !task.check_draft &&
    !task.project_routing?.relatedProjects?.length &&
    (!task.project_routing || task.project_routing.status === "clear") &&
    task.branch_selection?.basis !== "uncertain"
  );
}

function quickDecision(
  task: Task | undefined,
  state: State,
  admin: boolean,
): QuickDecision | null {
  if (!admin || !task) return null;
  if (
    task.status === "failed" &&
    primaryFix(parseFailure(task.last_error)).kind === "retry"
  )
    return { kind: "retry", task, label: "重試" };
  if (!simpleApproval(task) || !task.target_branch) return null;
  const project = state.projects.find(({ id }) => id === task.project_id);
  const group = state.groups.find(({ id }) => id === task.group_id);
  if (
    !project?.enabled ||
    !project.config_version ||
    !group?.enabled ||
    !group.binding_version ||
    !group.project_ids?.includes(project.id)
  )
    return null;
  return {
    kind: "approve",
    task,
    label: task.mode === "query" ? "開始查詢" : "核准修改",
    projectName: project.name,
    body: {
      project_id: project.id,
      target_branch: task.target_branch,
      config_version: project.config_version,
      binding_version: group.binding_version,
    },
  };
}

export function matchesDecision(decision: QuickDecision, detail: Detail) {
  const { task, projectReview } = detail;
  if (task.id !== decision.task.id || task.version !== decision.task.version)
    return false;
  if (decision.kind === "retry")
    return (
      task.status === "failed" && task.last_error === decision.task.last_error
    );
  return (
    simpleApproval(task) &&
    task.mode === decision.task.mode &&
    task.project_id === decision.body.project_id &&
    task.target_branch === decision.body.target_branch &&
    projectReview?.config_version === decision.body.config_version &&
    projectReview.binding_version === decision.body.binding_version &&
    projectReview.project_name === decision.projectName
  );
}

function waitingLabel(since: string | null) {
  if (!since) return "等待時間未提供";
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  if (days >= 1) return `等了 ${days} 天`;
  const relative = ago(since);
  return relative === "剛剛"
    ? "剛開始等待"
    : `等了 ${relative.replace(/前$/, "")}`;
}

export function ReviewQueue({
  items,
  selected,
  sort,
  setSort,
  choose,
  move,
  decide,
  busy,
  state,
  admin,
  batchControls,
  checkbox,
}: {
  items: readonly ReviewItem[];
  selected: string | null;
  sort: ReviewSort;
  setSort: (sort: ReviewSort) => void;
  choose: (id: string) => void;
  move: (id: string, focus?: boolean) => void;
  decide: (item: ReviewItem, decision: QuickDecision) => void;
  busy: boolean;
  state: State;
  admin: boolean;
  batchControls?: ReactNode;
  checkbox: (item: ReviewItem) => ReactNode;
}) {
  const queueId = useId();
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return (
    <Tabs
      value={sort}
      onValueChange={(value) =>
        setSort(value === "newest" ? "newest" : "oldest")
      }
      className="min-w-0 gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <TabsList
          aria-label="待決策排序"
          className="h-auto max-w-full overflow-x-auto"
        >
          <TabsTrigger
            value="oldest"
            aria-controls={queueId}
            className="min-h-11 flex-none md:min-h-8"
          >
            等最久
          </TabsTrigger>
          <TabsTrigger
            value="newest"
            aria-controls={queueId}
            className="min-h-11 flex-none md:min-h-8"
          >
            最新
          </TabsTrigger>
        </TabsList>
        <p className="text-xs text-muted-foreground">
          選取案件後：J／K 切換，Enter 查看詳情{admin && "，A 處理"}
        </p>
      </div>
      {batchControls}
      <TabsContent id={queueId} value={sort} tabIndex={-1} className="min-w-0">
        <ul
          role="list"
          aria-label="待決策佇列"
          className="work-ledger divide-y"
        >
          {items.map((item, index) => {
            const task = tasks.get(item.id);
            const decision = quickDecision(task, state, admin);
            const active = selected === item.id;
            const titleId = `${queueId}-title-${item.id}`;
            const handle = () =>
              decision ? decide(item, decision) : choose(item.id);
            const label =
              decision?.label ??
              (item.kind === "pickList"
                ? "挑選任務"
                : task?.question
                  ? "回答問題"
                  : task && !task.project_id
                    ? "選專案"
                    : "審核");
            const Icon =
              decision?.kind === "retry"
                ? RotateCcw
                : decision
                  ? Check
                  : ChevronRight;
            return (
              <li
                key={item.id}
                className={cn(
                  "flex min-w-0 items-center gap-1 pr-2 sm:gap-3 sm:pr-4",
                  active && "bg-muted/55 shadow-[inset_3px_0_var(--primary)]",
                )}
              >
                {checkbox(item)}
                <div className="relative grid min-h-11 min-w-0 flex-1 gap-1 rounded-md px-2 py-3 hover:bg-muted/70 sm:px-4">
                  <button
                    type="button"
                    data-review-row={item.id}
                    aria-current={active || undefined}
                    aria-labelledby={`${titleId} ${titleId}-details`}
                    aria-describedby={`${titleId}-status ${titleId}-meta`}
                    aria-keyshortcuts={
                      admin
                        ? "j k ArrowUp ArrowDown Enter a"
                        : "j k ArrowUp ArrowDown Enter"
                    }
                    tabIndex={active ? 0 : -1}
                    className="absolute inset-0 z-[1] h-full w-full rounded-md text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
                    onFocus={() => move(item.id)}
                    onClick={() => choose(item.id)}
                    onKeyDown={(event) => {
                      if (
                        event.altKey ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.shiftKey ||
                        event.nativeEvent.isComposing
                      )
                        return;
                      const offset =
                        event.key === "ArrowDown" || event.key === "j"
                          ? 1
                          : event.key === "ArrowUp" || event.key === "k"
                            ? -1
                            : 0;
                      if (offset) {
                        event.preventDefault();
                        const target = items[index + offset];
                        if (target) move(target.id, true);
                      } else if (
                        (admin && event.key === "a") ||
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        if (!busy && !event.repeat) {
                          if (event.key === "Enter")
                            setTimeout(() => choose(item.id), 0);
                          else handle();
                        }
                      }
                    }}
                  >
                    <span id={`${titleId}-details`} className="sr-only">
                      查看詳情
                    </span>
                  </button>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span
                      id={titleId}
                      className="line-clamp-2 text-base leading-snug font-semibold [overflow-wrap:anywhere]"
                    >
                      {item.title}
                    </span>
                    <span
                      id={`${titleId}-status`}
                      data-review-status
                      className="text-xs font-medium"
                    >
                      {item.status}
                    </span>
                  </span>
                  <span
                    id={`${titleId}-meta`}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground sm:text-sm"
                  >
                    {decision?.kind === "approve" && (
                      <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                        {decision.projectName}／{decision.body.target_branch}
                      </span>
                    )}
                    <span className="max-w-full truncate">{item.group}</span>
                    <span>
                      {item.platform
                        ? groupPlatformLabels[item.platform]
                        : "平台未記錄"}
                    </span>
                    <span
                      data-review-waiting
                      className="whitespace-nowrap tabular-nums"
                    >
                      {waitingLabel(item.waitingSince)}
                    </span>
                  </span>
                </div>
                {admin && (
                  <Button
                    type="button"
                    variant={decision ? "outline" : "ghost"}
                    size="sm"
                    aria-describedby={titleId}
                    disabled={busy}
                    onClick={handle}
                    className="min-h-11 min-w-11 px-2 md:min-h-9"
                  >
                    <Icon aria-hidden className="max-sm:hidden" />
                    {label}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </TabsContent>
    </Tabs>
  );
}
