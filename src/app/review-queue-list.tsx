import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pickListReviewId, type ReviewItem } from "../../shared/review-queue.js";
import { groupPlatformLabels, inboxStatusLabels } from "../../shared/status-glossary.js";
import type { Task } from "../../shared/types.js";
import { ago, type Detail, type State } from "./shared";

function simpleChange(task: Task) {
  return task.mode === "change" && task.status === "awaiting_approval" &&
    !task.last_error && !task.question && task.missing?.length === 0 && task.suggestions?.length === 0 &&
    task.risk_reasons?.length === 0 && task.pending_paths?.length === 0 &&
    !task.assumptions?.length && !task.baseline_repair && !task.check_draft &&
    !task.project_routing?.relatedProjects?.length &&
    (!task.project_routing || task.project_routing.status === "clear") &&
    task.branch_selection?.basis !== "uncertain";
}

export function quickApproval(task: Task | undefined, state: State, admin: boolean) {
  if (!admin || !task || !simpleChange(task) || !task.target_branch) return null;
  const project = state.projects.find(({ id }) => id === task.project_id);
  const group = state.groups.find(({ id }) => id === task.group_id);
  if (!project?.enabled || !project.validated_at || project.repo_missing_at || !project.config_version ||
      !group?.enabled || !group.binding_version || !group.project_ids?.includes(project.id))
    return null;
  return {
    task, projectName: project.name, repo: project.repo, baseBranch: project.base_branch,
    body: {
      project_id: project.id, target_branch: task.target_branch,
      config_version: project.config_version, binding_version: group.binding_version,
    },
  };
}

export type QuickApproval = NonNullable<ReturnType<typeof quickApproval>>;

export function matchesApproval(expected: QuickApproval, { task, projectReview }: Detail) {
  return simpleChange(task) && task.id === expected.task.id &&
    task.version === expected.task.version && task.group_id === expected.task.group_id &&
    task.project_id === expected.body.project_id && task.target_branch === expected.body.target_branch &&
    projectReview?.config_version === expected.body.config_version &&
    projectReview.binding_version === expected.body.binding_version &&
    projectReview.project_name === expected.projectName && projectReview.repo === expected.repo &&
    projectReview.base_branch === expected.baseBranch;
}

function waitingLabel(since: string | null) {
  if (!since) return "等待時間未提供";
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  if (days >= 1) return `等了 ${days} 天`;
  const relative = ago(since);
  return relative === "剛剛" ? "剛開始等待" : `等了 ${relative.replace(/前$/, "")}`;
}

function openAction(status: string) {
  if (status === inboxStatusLabels.answer) return "回答補問";
  if (status === inboxStatusLabels.chooseProject) return "選專案";
  if (status === inboxStatusLabels.fix(inboxStatusLabels.retry)) return "重試";
  return "查看";
}

export function ReviewKeyboardHint() {
  return (
    <span className="ml-auto hidden text-xs text-muted-foreground lg:pointer-fine:inline [@media(any-pointer:coarse)]:hidden!">
      J／K 切換，Enter 開啟，Alt + Enter 執行主要決定
    </span>
  );
}

export type SelectionMode = "move" | "enter" | "click";

export function ReviewQueue({
  items, selected, desktop, choose, decide, busy, checking, state, admin, detail, rowErrors, batchControls, checkbox,
}: {
  items: readonly ReviewItem[];
  selected: string | null;
  desktop: boolean;
  choose: (id: string, mode: SelectionMode) => void;
  decide: (approval: QuickApproval) => void;
  busy: boolean;
  checking: boolean;
  state: State;
  admin: boolean;
  detail?: Detail;
  rowErrors: Readonly<Record<string, string>>;
  batchControls?: ReactNode;
  checkbox: (item: ReviewItem) => ReactNode;
}) {
  const queueId = useId();
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const projects = new Map(state.projects.map((project) => [project.id, project.name]));
  const riskyLists = new Set(state.pickLists?.filter((list) => list.items.some((entry) => entry.riskReasons?.length))
    .map((list) => pickListReviewId(list.id)));
  const tabbable = selected ?? items[0]?.id;
  return (
    <div className="min-w-0">
      {batchControls}
      <ul role="list" aria-label="待決策佇列" className={cn("work-ledger grid divide-y", !items.some(({ id }) => rowErrors[id]) && "auto-rows-fr")}>
        {items.map((item, index) => {
          const task = tasks.get(item.id);
          const candidate = quickApproval(task, state, admin);
          const error = rowErrors[item.id];
          const approval = candidate && !error && (!detail || detail.task.id !== item.id || matchesApproval(candidate, detail))
            ? candidate : null;
          const check = checkbox(item);
          const titleId = `${queueId}-title-${item.id}`;
          const current = detail?.task.id === item.id ? detail.task : task;
          const risky = Boolean(task?.risk_reasons?.length || task?.pending_paths?.length ||
            current?.risk_reasons?.length || current?.pending_paths?.length || riskyLists.has(item.id));
          const project = current?.project_id ? projects.get(current.project_id) : undefined;
          const target = project && [project, current?.target_branch].filter(Boolean).join("／");
          const source = [item.group, item.platform ? groupPlatformLabels[item.platform] : "平台未記錄", target].filter(Boolean).join(" ");
          return (
            <li key={item.id} className={cn(
              "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(1.25rem,1fr)_2.75rem] items-center py-1 pr-2 lg:grid-rows-[1.25rem_2rem] lg:py-1.5",
              selected === item.id && "bg-primary-soft shadow-[inset_3px_0_var(--primary)]",
            )}>
              {check && <div className="z-1 col-start-1 row-[1/3]">{check}</div>}
              <button
                type="button"
                data-review-row={item.id}
                aria-current={selected === item.id ? "true" : undefined}
                aria-keyshortcuts="j k ArrowUp ArrowDown Enter Alt+Enter"
                tabIndex={tabbable === item.id ? 0 : -1}
                className={cn(
                  "col-span-full row-span-2 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-subgrid items-center gap-x-2 self-stretch rounded-sm pl-3 text-left outline-none hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-foreground",
                  check && "pl-11",
                )}
                onClick={() => choose(item.id, "click")}
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
                      event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (!event.repeat) setTimeout(() => choose(item.id, "enter"), 0);
                    return;
                  }
                  const forward = event.key === "ArrowDown" || event.key === "j";
                  if (!forward && event.key !== "ArrowUp" && event.key !== "k") return;
                  event.preventDefault();
                  const next = items[index + (forward ? 1 : -1)];
                  if (!next) return;
                  if (desktop) setTimeout(() => choose(next.id, "move"), 0);
                  else event.currentTarget.closest("ul")
                    ?.querySelector<HTMLButtonElement>(`[data-review-row="${CSS.escape(next.id)}"]`)
                    ?.focus();
                }}
              >
                <span id={titleId} title={item.title} className="col-span-full row-start-1 line-clamp-2 min-w-0 text-base leading-5 font-semibold [overflow-wrap:anywhere] lg:col-span-1 lg:block lg:truncate">
                  {item.title}
                </span>
                <span className="col-start-1 row-start-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground lg:col-span-full lg:mr-[4.5rem]">
                  {risky && (
                    <span className="shrink-0 rounded bg-warn-soft px-1 py-0.5 font-medium text-warn">
                      {inboxStatusLabels.risk}
                    </span>
                  )}
                  <span title={source} className="truncate">{source}</span>
                </span>
                <span data-review-waiting className="col-start-2 row-start-2 mr-[4.5rem] justify-self-end text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:row-start-1 lg:mr-0">
                  {waitingLabel(item.waitingSince)}
                </span>
              </button>
              <Button
                type="button" variant={approval ? "default" : "secondary"} size="sm"
                aria-describedby={titleId}
                disabled={busy || (!!approval && checking)}
                className="z-1 col-start-3 row-start-2 min-h-11 w-16 justify-self-end px-1 text-xs lg:min-h-8"
                onClick={() => approval ? decide(approval) : choose(item.id, "click")}
              >
                {approval ? "核准修改" : openAction(item.status)}
              </Button>
              {error && <p role="alert" className="col-span-full row-start-3 px-3 py-1 text-sm text-danger [overflow-wrap:anywhere]">{error}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
