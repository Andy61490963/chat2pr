import {
  groupDeliveryLabels,
  groupLabels,
  groupPlatformLabels,
  groupStatus,
} from "../../shared/status-glossary.js";
import { groupReplyStatus } from "../../shared/group-reply-status.js";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { Group, Memory } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Separator, Switch } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Request, type Run, type State, date, Empty } from "./shared";
import { pickSettings } from "./settings";
import { ConfirmButton } from "./confirm";
import { useGuard, useUnsaved } from "./unsaved";

// 群組開著但沒有任何「已啟用且驗證過」的專案時，收到需求也沒辦法派工。
const usable = (g: Group, state: State) =>
  state.projects.some(
    (p) => g.project_ids.includes(p.id) && p.enabled && p.validated_at,
  );
// LINE 的多人聊天室（不是群組）沒有名稱可同步，讓管理者自己取名。
const room = (g: Group) => g.id.startsWith("R");
// 這些狀態的任務會因為群組綁定變更而退回待審核。
const underway = ["queued", "budget_wait", "failed", "running", "reviewing"];
const noProjectHint =
  "這個群組沒有可用的專案（沒綁定、專案停用、還沒驗證，或儲存庫找不到），收到的需求目前沒辦法派工。";

const memorySource: Record<Memory["source"], string> = {
  ai: "AI 自動記住",
  chat: "群組要求",
  admin: "管理者",
};

export function GroupStatusBadge({
  group,
  state,
}: {
  group: Group;
  state: State;
}) {
  const status = groupStatus(group, usable(group, state));
  const variant = {
    left: "secondary",
    disabled: "secondary",
    stopped: "danger",
    error: "warn",
    ready: "good",
    unbound: "warn",
  } as const;
  return (
    <Badge
      variant={variant[status]}
      title={
        status === "unbound"
          ? noProjectHint
          : status === "stopped" || status === "error"
            ? (group.triage_error ?? undefined)
            : undefined
      }
    >
      {groupLabels[status]}
    </Badge>
  );
}

// 單筆記憶：顯示來源，可直接修改內容與對應專案或刪除。
function MemoryItem({
  memory: m,
  state,
  group: g,
  busy,
  run,
  request,
}: {
  memory: Memory;
  state: State;
  group: Group;
  busy: boolean;
  run: Run;
  request: Request;
}) {
  const [editing, setEditing] = useState(false),
    [content, setContent] = useState(m.content),
    [project, setProject] = useState(m.project_id ?? "none");
  const projectLabel = state.projects.find((p) => p.id === m.project_id)?.name;
  if (editing)
    return (
      <li>
        <form
          className="grid gap-2 p-3 sm:grid-cols-[1fr_11rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await request(`/api/memories/${m.id}`, "PUT", {
                content,
                project_id: project === "none" ? null : project,
              });
              setEditing(false);
            }, "已更新記憶");
          }}
        >
          <Input
            aria-label="記憶內容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            minLength={2}
            required
            autoFocus
          />
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="w-full" aria-label="對應專案">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不指定專案</SelectItem>
              {state.projects
                .filter((p) => g.project_ids.includes(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            <Button size="sm" disabled={busy}>
              儲存
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setContent(m.content);
                setProject(m.project_id ?? "none");
                setEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </form>
      </li>
    );
  return (
    <li className="flex items-start gap-2 py-2.5 pr-1.5 pl-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm [overflow-wrap:anywhere]">{m.content}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className={m.source === "ai" ? "text-info" : undefined}>
            {memorySource[m.source] ?? "群組要求"}
          </span>
          {projectLabel && (
            <>
              <span aria-hidden>·</span>
              {projectLabel}
            </>
          )}
          {m.project_id && !g.project_ids.includes(m.project_id) && (
            <>
              <span aria-hidden>·</span>
              <span className="text-warn">
                專案已不在此群組，AI 暫不使用這條記憶
              </span>
            </>
          )}
          <span aria-hidden>·</span>
          {date(m.created_at)}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="修改記憶"
        title="修改"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
      <ConfirmButton
        variant="ghost"
        size="icon-sm"
        aria-label="刪除記憶"
        disabled={busy}
        title="刪除這條記憶？"
        description="刪除後 AI 判讀這個群組的需求時不會再參考它，也不能復原。"
        confirm="刪除記憶"
        onConfirm={() =>
          run(() => request(`/api/memories/${m.id}`, "DELETE"), "已刪除記憶")
        }
      >
        <Trash2 />
      </ConfirmButton>
    </li>
  );
}

export function GroupsView({
  state,
  busy,
  run,
  request,
  openSettings,
}: {
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  openSettings: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Group["platform"] | "all">("all");
  const guard = useGuard();
  const open = state.groups.find((g) => g.id === openId);
  if (!state.groups.length)
    return (
      <Card>
        <Empty icon={<MessageSquare />} title="還沒有群組">
          把機器人加入 LINE 群組或 Discord
          伺服器，再在群組或文字頻道傳一則訊息。
        </Empty>
      </Card>
    );
  // 機器人已離開的群組留著查紀錄，但排到最後、不算進統計。
  const matches = state.groups.filter(
    (g) => platform === "all" || g.platform === platform,
  );
  const present = matches.filter((g) => !g.left_at);
  const gone = matches.length - present.length;
  const groups = [...present, ...matches.filter((g) => g.left_at)];
  const states = present.map((g) => groupStatus(g, usable(g, state)));
  const stuck = states.filter((status) => status === "unbound").length;
  const halted = states.filter((status) => status === "stopped").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="group-platform" className="text-sm font-medium">
          聊天平台
        </label>
        <Select
          value={platform}
          onValueChange={(value) => setPlatform(value as typeof platform)}
        >
          <SelectTrigger id="group-platform" className="min-h-11 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="min-h-11" value="all">
              全部平台
            </SelectItem>
            <SelectItem className="min-h-11" value="line">
              {groupPlatformLabels.line}
            </SelectItem>
            <SelectItem className="min-h-11" value="discord">
              {groupPlatformLabels.discord}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        共 {present.length} 個群組，
        {
          present.filter((g) => groupStatus(g, usable(g, state)) === "ready")
            .length
        }{" "}
        個{groupLabels.ready}
        {stuck > 0 && `，${stuck} 個${groupLabels.unbound}`}
        {halted > 0 && `，${halted} 個${groupLabels.stopped}`}
        {gone > 0 && `；另有 ${gone} 個${groupLabels.left}`}
      </p>
      {groups.length === 0 ? (
        <Empty icon={<MessageSquare />} title="這個平台還沒有群組">
          把機器人加入群組或伺服器，並傳一則訊息。
        </Empty>
      ) : (
        <div className="@container">
          <div className="@3xl:rounded-xl @3xl:border @3xl:bg-card @3xl:text-card-foreground">
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,2fr)_5rem_7rem] gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground @3xl:grid"
            >
              <span>群組</span>
              <span>觸發方式</span>
              <span>可修改的專案</span>
              <span>記憶</span>
              <span className="text-right">狀態</span>
            </div>
            <ul role="list" className="grid gap-3 @3xl:block @3xl:divide-y">
              {groups.map((g) => {
                const projects = state.projects.filter((p) =>
                  g.project_ids.includes(p.id),
                );
                const memories = state.memories.filter(
                  (m) => m.group_id === g.id,
                ).length;
                return (
                  <li
                    key={g.id}
                    className="rounded-xl border bg-card text-card-foreground @3xl:rounded-none @3xl:border-0"
                  >
                    <button
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 rounded-[inherit] px-5 py-3 text-left transition-colors hover:bg-muted/40 @3xl:grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,2fr)_5rem_7rem] @3xl:items-center"
                      onClick={() => setOpenId(g.id)}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
                        <span className="[overflow-wrap:anywhere]">
                          {g.name}
                        </span>
                        <Badge variant="secondary">
                          {groupPlatformLabels[g.platform]}
                        </Badge>
                      </span>
                      <span className="col-span-2 text-sm @3xl:col-auto">
                        <span className="mr-2 text-xs text-muted-foreground @3xl:sr-only">
                          觸發方式
                        </span>
                        {g.trigger_mode === "auto"
                          ? "自動辨識"
                          : g.platform === "discord"
                            ? "指令或提及機器人"
                            : "指令與引用追問"}
                      </span>
                      <span
                        className={cn(
                          "col-span-2 text-sm [overflow-wrap:anywhere] @3xl:col-auto",
                          !projects.length && "text-warn",
                        )}
                      >
                        <span className="mr-2 text-xs text-muted-foreground @3xl:sr-only">
                          可修改的專案
                        </span>
                        <span>
                          {projects.map((p) => p.name).join("、") || "尚未綁定"}
                        </span>
                      </span>
                      <span className="col-span-2 text-sm text-muted-foreground tabular-nums @3xl:col-auto">
                        <span className="mr-2 text-xs @3xl:sr-only">記憶</span>
                        {memories} 筆
                      </span>
                      <span className="col-start-2 row-start-1 flex justify-end @3xl:col-auto @3xl:row-auto">
                        <span className="sr-only">狀態</span>
                        <GroupStatusBadge group={g} state={state} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      {open && (
        <Sheet
          open
          onOpenChange={(o) =>
            !o && guard(() => setOpenId(null), { prefixes: ["group"] })
          }
        >
          <SheetContent className="sm:max-w-xl">
            <SheetHeader>
              <SheetTitle className="text-lg [overflow-wrap:anywhere]">
                {open.name}
              </SheetTitle>
              <SheetDescription>
                {open.platform === "discord"
                  ? groupPlatformLabels.discord
                  : room(open)
                    ? "多人聊天室在 LINE 沒有名稱，可以在下方自己取名"
                    : "名稱與 LINE 群組同步"}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-5">
              <GroupCard
                key={open.id}
                group={open}
                openSettings={openSettings}
                state={state}
                busy={busy}
                run={run}
                request={request}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function GroupCard({
  group: g,
  state,
  busy,
  run,
  request,
  openSettings,
}: {
  group: Group;
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  openSettings: () => void;
}) {
  const [name, setName] = useState(g.name),
    [ids, setIds] = useState<string[]>(g.project_ids),
    [enabled, setEnabled] = useState(g.enabled),
    [triggerMode, setTriggerMode] = useState(g.trigger_mode),
    [replyMode, setReplyMode] = useState(g.reply_mode ?? "results"),
    [memo, setMemo] = useState(""),
    [memoProject, setMemoProject] = useState("none");
  // 即時狀態更新不應清掉管理者尚未儲存的修改：每個欄位只在它自己的已存值改變時才同步，
  // 例如 LINE 群組改名不會把還沒儲存的專案綁定洗掉。
  const savedIds = g.project_ids.join();
  useEffect(() => setName(g.name), [g.name]);
  useEffect(() => setIds(g.project_ids), [savedIds]);
  useEffect(() => setEnabled(g.enabled), [g.enabled]);
  useEffect(() => setTriggerMode(g.trigger_mode), [g.trigger_mode]);
  useEffect(() => setReplyMode(g.reply_mode ?? "results"), [g.reply_mode]);
  const rename = name.trim() || g.name;
  const dirty =
    rename !== g.name ||
    enabled !== g.enabled ||
    triggerMode !== g.trigger_mode ||
    replyMode !== (g.reply_mode ?? "results") ||
    ids.join() !== savedIds;
  useUnsaved(`group:${g.id}`, dirty);
  // 儲存前先講清楚會連帶發生的事，不再默默丟掉訊息或把任務退回。
  const dropsPending =
    !!g.first_pending_at &&
    (enabled !== g.enabled || triggerMode !== g.trigger_mode);
  const bounced =
    ids.join() !== savedIds
      ? (g.affected_tasks ??
        state.tasks.filter(
          (t) => t.group_id === g.id && underway.includes(t.status),
        ).length)
      : 0;
  const memories = state.memories.filter((m) => m.group_id === g.id);
  // 因為儲存庫找不到而暫時解除綁定的專案。
  const parked = state.projects.filter(
    (p) => p.repo_missing_at && p.repo_missing_state?.groups.includes(g.id),
  );
  const toggle = (id: string) =>
    setIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  return (
    <div className="flex flex-col gap-5">
      {g.left_at && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          機器人已在 {date(g.left_at)}{" "}
          離開這個群組，收不到新訊息。把機器人重新邀請進群組後，再回來這裡啟用。
        </p>
      )}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!!g.left_at}
          />
          允許這個群組提出需求
        </label>
        <GroupStatusBadge group={g} state={state} />
      </div>
      {room(g) && (
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor={`name-${g.id}`}>
            名稱
          </label>
          <Input
            id={`name-${g.id}`}
            className="sm:max-w-sm"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}
      {g.enabled && !usable(g, state) && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {noProjectHint}
        </p>
      )}
      {parked.length > 0 && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          專案{parked.map((p) => `「${p.name}」`).join("")}
          的儲存庫找不到，暫時從這個群組解除綁定；接回後會自動綁回來。
        </p>
      )}
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor={`mode-${g.id}`}>
          需求觸發方式
        </label>
        <Select
          value={triggerMode}
          onValueChange={(v) => setTriggerMode(v as Group["trigger_mode"])}
        >
          <SelectTrigger id={`mode-${g.id}`} className="w-full sm:max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="command">
              {g.platform === "discord" ? "指令或提及機器人" : "指令與引用追問"}
            </SelectItem>
            <SelectItem value="auto">自動辨識</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {triggerMode === "command"
            ? g.platform === "discord"
              ? "用 /任務 開頭，或提及機器人並寫下需求。"
              : "你可以用 /任務 或引用機器人的回答提出需求。"
            : "你在群組提出明確需求時，AI 會自動辨識並略過同事分工與未定案的討論。"}
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">說明</summary>
          <div className="mt-1">
            {triggerMode === "command"
              ? g.platform === "discord"
                ? "一般聊天只供檢視。提出需求時，可以在同一則訊息附圖，或引用先前的圖片。"
                : "一般聊天只保存、不辨識。請以 /任務 開頭提出新需求；引用機器人的任務回答可直接追問。附圖時，先傳圖片，再引用該圖片輸入 /任務 與說明。"
              : "AI 會辨識新訊息並略過閒聊；修改先確認專案，明確且有依據的查詢可自動執行。不希望自動辨識時請選指令模式。"}{" "}
            切換只套用到之後的新訊息。
          </div>
        </details>
      </div>
      {g.platform === "discord" ? (
        <p className="text-sm text-muted-foreground">
          {groupDeliveryLabels.unsupportedPlatform}
        </p>
      ) : (
        <div className="grid gap-2">
          <p role="status" className="text-sm font-medium">
            目前：{groupReplyStatus(g, state.settings, state.health).text}
            {!g.left_at && state.settings.group_replies === false && (
              <Button size="sm" variant="link" onClick={openSettings}>
                前往設定
              </Button>
            )}
          </p>
          <label className="text-sm font-medium" htmlFor={`reply-${g.id}`}>
            在群組回覆
          </label>
          <Select
            value={replyMode}
            onValueChange={(v) =>
              setReplyMode(v as NonNullable<Group["reply_mode"]>)
            }
          >
            <SelectTrigger id={`reply-${g.id}`} className="w-full sm:max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="results">只回覆結果</SelectItem>
              <SelectItem value="all">收到需求時也回覆</SelectItem>
              <SelectItem value="off">不在群組回覆</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {replyMode === "off"
              ? "你儲存後，機器人會停止在這個群組回覆。"
              : replyMode === "all"
                ? "你儲存後，群組會收到需求等待確認的通知與處理結果。"
                : "你儲存後，群組會收到查詢答案與處理結果。"}
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">推播額度與 /進度</summary>
            <p>
              你用 /任務
              提出需求時的即時回覆不扣推播額度，後續推播依群組人數計費；額度用完可打
              /進度 補看結果。
            </p>
          </details>
        </div>
      )}
      {g.triage_error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          <AlertCircle className="size-4" />
          {g.triage_error}（已失敗 {g.triage_failures} 次）
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={busy}
            onClick={() =>
              void run(
                () => request(`/api/groups/${g.id}/retry`, "POST"),
                "已重新辨識",
              )
            }
          >
            重新辨識
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">可修改的專案</h3>
        <div className="flex flex-wrap gap-2">
          {/* 找不到儲存庫的專案不能綁定，不列出來。 */}
          {state.projects
            .filter((p) => !p.repo_missing_at)
            .map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={ids.includes(p.id) ? "default" : "outline"}
                onClick={() => toggle(p.id)}
                title={p.validated_at ? p.repo : "尚未通過環境驗證"}
              >
                {ids.includes(p.id) ? <Check /> : <Plus />}
                {p.name}
                {!p.validated_at && <Badge variant="warn">未驗證</Badge>}
              </Button>
            ))}
          {!state.projects.length && (
            <span className="text-sm text-muted-foreground">
              先到「專案」頁新增專案。
            </span>
          )}
        </div>
        {dirty && (dropsPending || bounced > 0) && (
          <ul className="flex list-disc flex-col gap-1 rounded-lg bg-warn-soft py-2 pr-3 pl-7 text-xs text-warn">
            {dropsPending && (
              <li>
                這個群組有訊息還在等辨識；儲存後這些訊息不會被辨識成需求，需要的話請在群組重新提出。
              </li>
            )}
            {bounced > 0 && (
              <li>
                變更綁定的專案後，這個群組 {bounced}{" "}
                個已排程或進行中的任務會退回待審核，要重新確認專案才會繼續。
              </li>
            )}
          </ul>
        )}
        {dirty && (
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    request(`/api/groups/${g.id}`, "PUT", {
                      name: rename,
                      project_ids: ids,
                      enabled,
                      trigger_mode: triggerMode,
                      reply_mode: replyMode,
                    }),
                  "群組設定已儲存",
                )
              }
            >
              儲存變更
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setName(g.name);
                setIds(g.project_ids);
                setEnabled(g.enabled);
                setTriggerMode(g.trigger_mode);
                setReplyMode(g.reply_mode ?? "results");
              }}
            >
              復原
            </Button>
          </div>
        )}
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-medium">記憶</h3>
            <p className="text-xs text-muted-foreground">
              AI 判斷要改哪個專案時會參考。AI 會從對話自動記住規則，在群組說「
              {g.trigger_mode === "command" ? "/任務 " : ""}
              記住：…」也會新增；你可以隨時修改或刪除。
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={state.settings.auto_memory ?? true}
              disabled={busy}
              onCheckedChange={(v) =>
                void run(
                  () =>
                    request("/api/settings", "PUT", {
                      ...pickSettings(state.settings),
                      auto_memory: v,
                    }),
                  v ? "已開啟 AI 自動記憶" : "已關閉 AI 自動記憶",
                )
              }
            />
            AI 自動記憶
          </label>
        </div>
        {memories.length ? (
          <ul className="flex flex-col divide-y rounded-lg border">
            {memories.map((m) => (
              <MemoryItem
                key={`${m.id}-${m.content}-${m.project_id}`}
                memory={m}
                state={state}
                group={g}
                busy={busy}
                run={run}
                request={request}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">還沒有記憶。</p>
        )}
        <form
          className="grid gap-2 sm:grid-cols-[1fr_11rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await request(`/api/groups/${g.id}/memories`, "POST", {
                content: memo,
                project_id: memoProject === "none" ? null : memoProject,
              });
              setMemo("");
            }, "已新增記憶");
          }}
        >
          <Input
            placeholder="例：報工、工單相關都改 MES 前端"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            minLength={2}
            required
          />
          <Select value={memoProject} onValueChange={setMemoProject}>
            <SelectTrigger className="w-full" aria-label="對應專案">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不指定專案</SelectItem>
              {state.projects
                .filter((p) => g.project_ids.includes(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button variant="outline" disabled={busy}>
            <Plus /> 新增
          </Button>
        </form>
      </div>
    </div>
  );
}
