import { useState } from "react";
import { Check, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Label } from "@/components/ui/form-controls";
import { projectLabels } from "../../shared/status-glossary.js";
import type { Project, Task } from "../../shared/types.js";
import { ConfirmButton } from "./confirm";
import type { Act, State, View } from "./shared";

/**
 * 等待額度時的次要按鈕只在 API 模式顯示，因為管理者可能剛提高預算。
 * 訂閱模式在額度恢復或保留比例調低至額度可用後由排程自動重試。
 */
export function BudgetRetry({
  task: t,
  state,
  busy,
  act,
}: {
  task: Task;
  state: State;
  busy: boolean;
  act: Act;
}) {
  if (t.status !== "budget_wait" || state.settings.ai_mode !== "api")
    return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() =>
        void act(t, "retry", {}, "已重新排程；額度仍不足時會回到等待額度")
      }
    >
      <RefreshCw /> 已提高預算，立即再試
    </Button>
  );
}

export function AssignProject({
  task: t,
  state,
  busy,
  act,
  go,
  sources,
  onBound,
  inWorkbench = false,
}: {
  task: Task;
  state: State;
  busy: boolean;
  act: Act;
  // 只有管理者能去群組與專案頁；沒給就只說明原因。
  go?: (v: View, projectId?: string | null) => void;
  sources?: { id: string; text: string | null }[];
  onBound?: () => unknown;
  inWorkbench?: boolean;
}) {
  const group = state.groups.find((g) => g.id === t.group_id);
  const bound = state.projects.filter((p) => group?.project_ids.includes(p.id));
  // 找不到儲存庫、還沒驗證或已停用的專案派不了工：列出來讓人知道原因，但不能選。
  const blocked = (p: Project) =>
    p.repo_missing_at
      ? projectLabels.missing
      : !p.validated_at
        ? "尚未驗證"
        : !p.enabled
          ? "已停用"
          : "";
  const options = bound.filter((p) => !blocked(p));
  const [pick, setPick] = useState(options.length === 1 ? options[0].id : "");
  const [remember, setRemember] = useState(false);
  const chosen = options.find((p) => p.id === pick);
  const rule = chosen ? `「${t.title}」這類需求改 ${chosen.name}` : "";
  const suggestions = (
    !t.project_id ? (t.project_routing?.unboundSuggestions ?? []) : []
  ).flatMap((suggestion) => {
    const project = state.projects.find((p) => p.id === suggestion.projectId);
    return project &&
      !blocked(project) &&
      project.config_version === suggestion.configVersion &&
      !bound.some((p) => p.id === project.id)
      ? [{ suggestion, project }]
      : [];
  });
  return (
    <div className="mt-4 flex flex-col gap-3">
      {suggestions.length > 0 && (
        <ul className="space-y-4">
          {suggestions.map(({ suggestion, project }) => {
            const cited =
              sources?.filter(
                (m) => m.text && suggestion.sourceIds.includes(m.id),
              ) ?? [];
            return (
              <li
                key={project.id}
                className="min-w-0 space-y-1 [overflow-wrap:anywhere]"
              >
                <p className="font-semibold">
                  看起來是 {project.name}（尚未綁定這個群組）
                </p>
                <p className="text-sm text-muted-foreground">
                  {suggestion.reason}
                </p>
                {cited.length > 0 && (
                  <details className="text-sm">
                    <summary className="flex min-h-11 cursor-pointer items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                      查看引用訊息
                    </summary>
                    {cited.map((m) => (
                      <blockquote
                        key={m.id}
                        className="mb-2 border-l-2 pl-3 whitespace-pre-wrap"
                      >
                        {m.text}
                      </blockquote>
                    ))}
                  </details>
                )}
                {go ? (
                  <Button
                    type="button"
                    variant={
                      !inWorkbench && suggestions.length === 1
                        ? "default"
                        : "outline"
                    }
                    className="h-auto min-h-11 max-w-full whitespace-normal border-muted-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground dark:border-muted-foreground"
                    disabled={busy}
                    aria-label={`綁定並指定這個專案（${project.name}）`}
                    onClick={async () => {
                      const assigned = await act(
                        t,
                        "bind_assign",
                        { project_id: project.id },
                        "已綁定並指定專案",
                      );
                      if (assigned) onBound?.();
                    }}
                  >
                    綁定並指定這個專案
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    你可以請管理者綁定並指定這個專案。
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <span className="text-sm font-medium">
        {suggestions.length
          ? "你也可以選擇已綁定的專案。"
          : "這次需求要處理哪個專案？"}
      </span>
      <div className="flex flex-wrap gap-2">
        {bound.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={
              !inWorkbench && pick === p.id && !suggestions.length
                ? "default"
                : "outline"
            }
            aria-pressed={pick === p.id}
            className={
              suggestions.length
                ? "h-auto min-h-11 max-w-full motion-reduce:transition-none"
                : undefined
            }
            disabled={!!blocked(p)}
            onClick={() => setPick(p.id)}
          >
            {pick === p.id && <Check />}
            <span className="min-w-0 whitespace-normal break-all text-left">
              {p.name}（{p.repo}）
              {blocked(p) &&
                (inWorkbench ? `（${blocked(p)}）` : `・${blocked(p)}`)}
            </span>
          </Button>
        ))}
      </div>
      {!options.length && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {bound.length
            ? "這個群組綁定的專案目前都不能派工，請先讓專案通過驗證並啟用。"
            : "這個群組還沒綁定專案，綁定後才能指定。"}
          {go ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() =>
                go(
                  bound.length ? "projects" : "groups",
                  bound.length === 1 ? bound[0].id : null,
                )
              }
            >
              {bound.length ? "前往專案" : "前往群組設定"} <ChevronRight />
            </Button>
          ) : (
            "請管理者處理。"
          )}
        </p>
      )}
      {chosen && (
        <Label className="font-normal text-muted-foreground">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
          />
          記住：{rule}
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={inWorkbench || suggestions.length ? "outline" : "default"}
          className={
            suggestions.length
              ? "min-h-11 motion-reduce:transition-none"
              : undefined
          }
          disabled={busy || !chosen}
          onClick={() =>
            void act(
              t,
              "assign",
              { project_id: pick, remember: remember ? rule : undefined },
              remember ? "已指定專案並記住" : "已指定專案",
            )
          }
        >
          {inWorkbench ? "確認指定專案" : "指定專案"}
        </Button>
        {!inWorkbench && <EndTaskButton task={t} busy={busy} act={act} />}
      </div>
    </div>
  );
}

export function EndTaskButton({
  task: t,
  busy,
  act,
}: {
  task: Task;
  busy: boolean;
  act: Act;
}) {
  const label = ["running", "reviewing"].includes(t.status)
    ? "停止並結束"
    : "結束任務";
  return (
    <ConfirmButton
      variant="outline"
      disabled={busy}
      title={label + "？"}
      description="結束後不會派工，你之後可在任務詳情按「重新開啟」。"
      confirm={label}
      onConfirm={() =>
        act(
          t,
          t.status === "awaiting_approval" ? "reject" : "cancel",
          {},
          "已結束任務",
        )
      }
    >
      {label}
    </ConfirmButton>
  );
}
