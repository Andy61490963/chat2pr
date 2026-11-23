import { useId, useRef, useState, type Ref } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { maxRelatedProjects } from "../../shared/project-routing.js";
import {
  endReasonLabels,
  endReasonText,
  endReasons,
  projectLabels,
  taskProjectLabels,
  type EndReason,
} from "../../shared/status-glossary.js";
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
  onPrimaryMount,
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
  onPrimaryMount?: (button: HTMLButtonElement | null) => void;
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
  const query = t.mode === "query";
  const fieldId = useId();
  const [picks, setPicks] = useState(() =>
    query && t.project_id
      ? [t.project_id, ...(t.project_routing?.relatedProjects ?? []).map((p) => p.id)]
      : options.length === 1
        ? [options[0].id]
        : [],
  );
  const [remember, setRemember] = useState(false);
  const selected = picks.filter((id) => options.some((p) => p.id === id));
  const chosen = options.find((p) => p.id === selected[0]);
  const atLimit = query && selected.length >= maxRelatedProjects + 1;
  const overLimit = query && selected.length > maxRelatedProjects + 1;
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
      {bound.length > 0 && (
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium">
            {query
              ? "查詢可以同時參考多個專案的原始碼"
              : "修改任務只能選一個專案，因為一個 PR 只能開在一個儲存庫"}
          </legend>
          {atLimit && (
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              {overLimit
                ? `最多可選 ${maxRelatedProjects} 個參考專案，請減少選擇後再指定。`
                : `已選滿 ${maxRelatedProjects} 個參考專案，取消勾選後即可更換。`}
            </p>
          )}
          <ul role="list" className="mt-2 divide-y rounded-lg border bg-background">
            {bound.map((p) => {
              const choiceId = `${fieldId}-${p.id}-choice`;
              const titleId = `${fieldId}-${p.id}-name`;
              const descriptionId = `${fieldId}-${p.id}-description`;
              const checked = selected.includes(p.id);
              const primary = query && chosen?.id === p.id;
              const unavailable = blocked(p);
              return (
                <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-x-2 px-3">
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 has-disabled:cursor-default">
                    <input
                      id={choiceId}
                      type={query ? "checkbox" : "radio"}
                      name={fieldId}
                      className="size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                      aria-labelledby={titleId}
                      aria-describedby={descriptionId}
                      data-task-project-choice=""
                      checked={checked}
                      disabled={busy || !!unavailable || (atLimit && !checked)}
                      onChange={(event) =>
                        setPicks(
                          query
                            ? event.currentTarget.checked
                              ? [...selected, p.id]
                              : selected.filter((id) => id !== p.id)
                            : [p.id],
                        )
                      }
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span id={titleId} className="block font-medium">
                        {p.name}
                      </span>
                      <span id={descriptionId} className="block">
                        <span className="block text-xs text-muted-foreground">{p.repo}</span>
                        {unavailable && <span className="block text-xs">{unavailable}</span>}
                        {primary && (
                          <span className="mt-1 inline-block rounded-sm bg-muted px-1.5 text-xs font-medium">
                            {taskProjectLabels.primary}
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                  {query && checked && !primary && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="min-h-11"
                      onClick={() => {
                        document.getElementById(choiceId)?.focus();
                        setPicks([p.id, ...selected.filter((id) => id !== p.id)]);
                      }}
                    >
                      設為主要<span className="sr-only">（{p.name}）</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
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
        <Label className="min-h-11 font-normal text-muted-foreground [overflow-wrap:anywhere]">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
          />
          <span className="min-w-0">記住：{rule}</span>
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={onPrimaryMount}
          variant={
            suggestions.length || (inWorkbench && !onPrimaryMount)
              ? "outline"
              : "default"
          }
          className="min-h-11 motion-reduce:transition-none"
          disabled={busy || !chosen || overLimit}
          onClick={() =>
            void act(
              t,
              "assign",
              {
                project_id: chosen?.id,
                remember: remember ? rule : undefined,
                ...(query ? { related_project_ids: selected.slice(1) } : {}),
              },
              remember ? "已指定專案並記住" : "已指定專案",
            )
          }
        >
          指定專案
        </Button>
        {/* 「結束任務」由審核面板的動作列提供，這裡不再放一個，避免同一畫面出現兩個。 */}
      </div>
    </div>
  );
}

/** 拒絕原因的單選清單與補充欄；審核面板的拒絕與收件匣的批次結束共用。 */
export function EndReasonFields({
  value,
  onChange,
  note,
  onNote,
  error,
  firstRef,
}: {
  value: EndReason | null;
  onChange: (value: EndReason) => void;
  note: string;
  onNote: (note: string) => void;
  error?: boolean;
  firstRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="grid gap-4">
      <fieldset
        className="grid gap-2"
        aria-describedby={error ? `${id}-error` : undefined}
      >
        <legend className="mb-2 text-sm font-medium">
          {endReasonText.legend}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {endReasons.map((reason, index) => (
            <label
              key={reason}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
                value === reason
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/40",
              )}
            >
              <input
                ref={index === 0 ? firstRef : undefined}
                type="radio"
                name={`${id}-reason`}
                value={reason}
                checked={value === reason}
                onChange={() => onChange(reason)}
                className="size-4 shrink-0 accent-primary"
              />
              {endReasonLabels[reason]}
            </label>
          ))}
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-danger">
            {endReasonText.required}
          </p>
        )}
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-note`}>{endReasonText.note}</Label>
        <Textarea
          id={`${id}-note`}
          value={note}
          maxLength={500}
          rows={2}
          onChange={(event) => onNote(event.target.value)}
          className="min-h-16 border-muted-foreground motion-reduce:transition-none"
        />
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
  const description = "結束後不會派工，你之後可在任務詳情按「重新開啟」。";
  if (t.status === "awaiting_approval")
    return (
      <RejectTaskButton task={t} busy={busy} act={act} description={description} />
    );
  return (
    <ConfirmButton
      variant="outline"
      disabled={busy}
      title={label + "？"}
      description={description}
      confirm={label}
      onConfirm={() => act(t, "cancel", {}, "已結束任務")}
    >
      {label}
    </ConfirmButton>
  );
}

// 待審核的任務結束就是拒絕：先選原因，判讀才能少建立同類任務。
function RejectTaskButton({
  task: t,
  busy,
  act,
  description,
}: {
  task: Task;
  busy: boolean;
  act: Act;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<EndReason | null>(null);
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setReason(null);
      setNote("");
      setMissing(false);
    }
  };
  const submit = () => {
    if (!reason) {
      setMissing(true);
      first.current?.focus();
      return;
    }
    reset(false);
    void act(
      t,
      "reject",
      { end_reason: reason, reason: note.trim() || undefined },
      "已結束任務",
    );
  };
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={busy}>
          結束任務
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg motion-reduce:animate-none"
      >
        <DialogHeader className="text-left">
          <DialogTitle>結束任務？</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <EndReasonFields
          value={reason}
          onChange={(value) => {
            setReason(value);
            setMissing(false);
          }}
          note={note}
          onNote={setNote}
          error={missing}
          firstRef={first}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" className="min-h-11">
              先不要
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={busy}
            onClick={submit}
          >
            結束任務
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
