import { splitQueryAnswer } from "../../shared/query-answer.js";
import { fullTaskTitle, taskListTitle } from "../../shared/task-title.js";
import { riskNotes } from "../../shared/risk-notes.js";
import { useEffect, useId, useRef, useState } from "react";
import { TaskContextEvidence } from "./context-evidence";
import { RunObserver } from "./run-observer";
import { QueryReport } from "./query-report";
import { TaskBranchPicker } from "./task-branch-picker";
import { TaskClarification } from "./task-clarification";
import {
  fixPage,
  fixPageLabels,
  parseFailure,
  primaryFix,
  waitHint,
} from "../../shared/failure-text.js";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AssignProject,
  BudgetRetry,
  EndTaskButton,
  type TaskDrawerAction,
} from "./inbox";
import { CopyButton } from "./copy-button";
import { deliveryNotice, undelivered } from "../../shared/group-delivery.js";
import {
  followupText,
  taskAcceptanceLabels,
  taskClarificationLabels,
} from "../../shared/status-glossary.js";
import { useUnsaved } from "./unsaved";
import {
  type Act,
  type Detail,
  type State,
  type View,
  ago,
  Clamped,
  collapseRepeats,
  date,
  groupName,
  Linkified,
  projectName,
  RunProgressLine,
  StatusBadge,
  StationTrack,
} from "./shared";

/**
 * 群組訊息沒送到時的提示：推播額度用完期間看板顯示「已回覆」，群組卻什麼都沒收到，
 * 每種訊息顯示最新一則的送達狀態，並在尚未送達時提供原文供管理者轉達。
 */
function GroupDeliveryNotes({
  deliveries,
  kinds,
}: {
  deliveries: Detail["groupDeliveries"];
  kinds: string[];
}) {
  const latest = kinds.flatMap((kind) => {
    const d = deliveries?.filter((x) => x.kind === kind).at(-1);
    return d && d.delivery.reason !== "superseded" ? [d] : [];
  });
  if (!latest.length) return null;
  return (
    <>
      {latest.map((d) => {
        const pending = undelivered(d.delivery);
        return (
          <div
            key={d.id}
            role="status"
            aria-label="群組訊息送達狀態"
            className={cn(
              "flex gap-2 rounded-lg px-3 py-2.5 text-sm",
              d.delivery.status === "sent"
                ? "bg-good-soft text-good"
                : !pending
                  ? "bg-muted text-muted-foreground"
                  : d.delivery.status === "failed"
                    ? "bg-danger-soft text-danger"
                    : d.delivery.reason
                      ? "bg-warn-soft text-warn"
                      : "bg-info-soft text-info",
            )}
          >
            {d.delivery.status === "sent" ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
            ) : d.delivery.status === "failed" || d.delivery.reason ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Clock className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-medium [overflow-wrap:anywhere]">
                {deliveryNotice(d.delivery, d.kind)}
              </p>
              {pending && d.kind === "group_question" && (
                <p className="text-xs [overflow-wrap:anywhere]">
                  成員可能還沒看到這則補問。可以在下方直接「送出回答」，或複製後貼到群組請成員回覆。
                </p>
              )}
              {pending &&
                (d.text ? (
                  <div>
                    <CopyButton
                      text={d.text}
                      label="複製群組訊息"
                      className="min-h-11"
                    />
                  </div>
                ) : (
                  <p className="text-xs">
                    原文已超過保存期限，無法複製；需要時請依任務結果重新轉達。
                  </p>
                ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

const clock = (v: string) =>
  new Date(v).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export function TaskDrawer({
  detail,
  state,
  busy,
  admin,
  startAction,
  actionStarted,
  close,
  go,
  act,
  open,
  followup,
  answer,
  relink,
}: {
  detail: Detail;
  state: State;
  busy: boolean;
  admin: boolean;
  /** 從收件匣開啟時要定位的表單。 */
  startAction?: TaskDrawerAction;
  actionStarted?: () => void;
  close: () => void;
  go: (v: View, projectId?: string | null) => void;
  act: Act;
  /** 開啟對話串中的另一題。 */
  open: (id: string) => void;
  /** 對已回答的查詢追問，建立新的一題。 */
  followup: (t: Detail["task"], text: string) => Promise<boolean>;
  /** 直接回答補問；成功才回傳 true，失敗時呼叫端保留輸入。 */
  answer: (t: Detail["task"], text: string) => Promise<boolean>;
  /** 接錯題時改接到另一題，或改成新話題（null）。 */
  relink: (t: Detail["task"], parentId: string | null) => unknown;
}) {
  const t = detail.task;
  const title = detail.fullTitle ?? fullTaskTitle(t.title, t.summary);
  const prSummary = detail.runs.find((run) => run.pr_summary)?.pr_summary;
  const hasPrResult =
    t.status === "ready" ||
    t.status === "merged" ||
    (t.status === "closed" && Boolean(prSummary || t.pr_url));
  const report =
    t.mode === "query"
      ? splitQueryAnswer(t.answer ?? "")
      : { body: t.status === "answered" ? (t.answer ?? "") : "", source: null };
  const sources = detail.runs.find(
    (r) => r.version === t.version && r.query_sources,
  )?.query_sources;
  const notes = riskNotes([
    ...t.risk_reasons,
    ...(t.question ? [] : t.missing),
  ]);
  const reopenHintId = useId();
  const editable = [
    "awaiting_approval",
    "queued",
    "failed",
    "budget_wait",
  ].includes(t.status);
  // 已回覆的任務可以補充需求後重新處理。
  const canAmend = editable || t.status === "answered";
  const canAnswer = t.status === "awaiting_approval" && !!t.question;
  const answerField = useRef<HTMLTextAreaElement>(null);
  const focusAnswer = () => {
    const field = answerField.current;
    if (!field) return false;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "center" });
    return true;
  };
  const saved = { summary: t.summary, acceptance: t.acceptance.join("\n") };
  const visibleAcceptance =
    t.mode === "query"
      ? t.acceptance.filter((item) => {
          const text = item.trim().replace(/^回答(?:追問)?[：:]?\s*/, "");
          return (
            item.trim() !== t.summary.trim() &&
            text !== t.summary.trim() &&
            item !== `回答追問：${t.summary.slice(0, 500)}`
          );
        })
      : t.acceptance;
  // 執行紀錄只提供整體範圍，尚無對應個別驗收條件的測試結果。
  const verification = detail.runs.find(
    (run) => run.version === t.version,
  )?.verification_scope;
  const [summary, setSummary] = useState(saved.summary);
  const [acceptance, setAcceptance] = useState(saved.acceptance);
  // 草稿是從哪個版本開始寫的；任務在背景更新時用來判斷要不要保留草稿。
  const [base, setBase] = useState({ version: t.version, ...saved });
  const [amendOpen, setAmendOpen] = useState(false);
  const [ask, setAsk] = useState("");
  useUnsaved("task-followup", ask.trim().length > 0);
  // 查詢回答後可以追問；修改開出 PR 或合併後可以追加修改。
  const canFollowup =
    (t.mode === "query" && t.status === "answered") ||
    (t.mode !== "query" && ["ready", "merged", "closed"].includes(t.status));
  const adding = t.mode !== "query";
  const followupPlatform = state.groups.find(
    (g) => g.id === t.group_id,
  )?.platform;
  const followupHelpId = useId();
  const thread = detail.thread;
  const [relinkTo, setRelinkTo] = useState("");
  const canRelink = [
    "awaiting_approval",
    "queued",
    "failed",
    "budget_wait",
    "answered",
  ].includes(t.status);
  // 改接候選：同群組已回答的查詢，排除自己與自己的後續題，最近的在前。
  const after = new Set((thread?.after ?? []).map((x) => x.id));
  const relinkOptions = state.tasks
    .filter(
      (x) =>
        x.group_id === t.group_id &&
        x.id !== t.id &&
        x.id !== t.parent_id &&
        !after.has(x.id) &&
        x.mode === "query" &&
        x.status === "answered",
    )
    .slice(0, 15);
  const lines = (v: string) =>
    v
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const amendDirty =
    canAmend && (summary !== base.summary || acceptance !== base.acceptance);
  useUnsaved("task", amendDirty);
  const resetDraft = () => {
    setSummary(saved.summary);
    setAcceptance(saved.acceptance);
    setBase({ version: t.version, ...saved });
    setAmendOpen(false);
  };
  const [pick, setPick] = useState<number | null>(
    t.suggestions.length === 1 ? 0 : null,
  );
  // 預設分頁依打開時的狀態決定：開發或驗證中、已有執行紀錄就先看執行紀錄。
  // 抽屜以任務 ID 為 key，只有換到另一個任務才重設；背景更新不會把使用者切過的分頁改回去。
  const [tab, setTab] = useState(() =>
    ["running", "reviewing"].includes(t.status) && detail.runs.length
      ? "runs"
      : "sources",
  );
  const [copied, setCopied] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const projectHeading = useRef<HTMLParagraphElement>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 任務出了新版本：選項與指定專案重來；補充需求的草稿只有沒動過（或剛存成這一版）才跟著更新，
  // 寫到一半的內容不再被背景更新洗掉。
  useEffect(() => {
    if (base.version === t.version) return;
    setPick(t.suggestions.length === 1 ? 0 : null);
    setAssignOpen(false);
    setBranchOpen(false);
    if (
      !amendDirty ||
      (summary === saved.summary &&
        lines(acceptance).join("\n") === saved.acceptance)
    )
      resetDraft();
  }, [t.version]);
  const stale = base.version !== t.version && amendDirty;
  const review = detail.projectReview;
  const confirmationBody = {
    project_id: t.project_id,
    binding_version: review?.binding_version,
    config_version: review?.config_version,
    target_branch: t.target_branch,
  };
  const canConfirm =
    !branchOpen &&
    !assignOpen &&
    !!t.project_id &&
    !!t.target_branch &&
    !!review?.config_version &&
    !!review?.binding_version;
  const deciding = t.status === "awaiting_approval" && !!t.project_id;
  const options =
    deciding && t.mode === "change" && !t.question && t.suggestions.length > 0;
  const sensitive = t.risk_reasons.length > 0;
  // 排隊原因（PR #42 的任務詳情 queue 欄位）；舊版伺服器沒有這個欄位時不顯示。
  const queue = t.status === "queued" ? (detail.queue ?? null) : null;
  // 建議指向的頁面只給管理者連結；成員進不了那些頁面。
  const queuePage = admin && queue ? fixPage(queue.hint) : null;
  // 自動重試排隊或重跑期間，last_error 是上一次嘗試的原因，不是目前已失敗。
  const retrying = ["queued", "running", "reviewing"].includes(t.status);
  const quotaWaitHint =
    t.status === "budget_wait"
      ? waitHint(t.last_error, state.settings.ai_mode)
      : null;
  const failure = t.status === "failed" ? parseFailure(t.last_error) : null;
  // 主動作與收件匣卡片共用 primaryFix；前往頁面只給管理者。
  const fix = primaryFix(failure);
  const fixTarget = admin && fix.kind === "page" ? fix.page : null;
  const amendFirst = t.status === "failed" && fix.kind === "amend";
  // 執行中的那一次（最新且未完成）：標頭顯示階段、已跑時間與期限。
  const live =
    ["running", "reviewing"].includes(t.status) &&
    detail.runs[0] &&
    !detail.runs[0].completed_at
      ? detail.runs[0]
      : null;
  const hasEvidence =
    detail.contextEvidence.length > 0 ||
    detail.images.length > 0 ||
    detail.references.length > 0;
  const openAmend = () => {
    setAmendOpen(true);
    requestAnimationFrame(() =>
      document.getElementById("amend-summary")?.focus(),
    );
  };
  const amendButton = canAmend && (
    <Button
      variant={
        !canAnswer &&
        (amendFirst || (deciding && t.missing.length > 0 && !options))
          ? "default"
          : "outline"
      }
      aria-expanded={amendOpen}
      aria-controls="amend-task"
      onClick={() => (amendOpen ? setAmendOpen(false) : openAmend())}
    >
      {amendOpen ? "收合修改表單" : taskClarificationLabels.amend}
      {amendDirty && <span className="text-xs">（尚未儲存）</span>}
    </Button>
  );
  // 從收件匣「縮小需求範圍」打開：直接展開補充需求編輯（只在剛打開時做一次）。
  useEffect(() => {
    if (startAction !== "amend") return;
    actionStarted?.();
    if (canAmend) openAmend();
  }, []);
  const resultReport = report.body && (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t.mode === "query" ? "調查結果" : "修改結果"}
        </h3>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(report.body)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
              .catch(() => {})
          }
        >
          {copied ? (
            <>
              <Check /> 已複製
            </>
          ) : (
            "複製完整報告"
          )}
        </Button>
      </div>
      <QueryReport
        key={t.id + ":" + t.version}
        answer={report.body}
        taskId={t.id}
        images={detail.reportImages}
      />
    </section>
  );
  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          if (startAction === "answer") {
            actionStarted?.();
            if (focusAnswer()) {
              event.preventDefault();
              return;
            }
          }
          if (!titleRef.current) return;
          event.preventDefault();
          titleRef.current.focus({ preventScroll: true });
        }}
      >
        <SheetHeader className="shrink-0 gap-2">
          <SheetTitle
            ref={titleRef}
            tabIndex={-1}
            className="text-lg leading-snug [overflow-wrap:anywhere] focus-visible:outline-hidden!"
          >
            {taskListTitle(t, title)}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs [overflow-wrap:anywhere]">
            <span>{t.mode === "query" ? "查詢任務" : "修改程式"}</span>
            <span>群組 {groupName(state, t)}</span>
            <span>專案 {projectName(state, t)}</span>
            {t.version > 1 && (
              <span className="tabular-nums">版本 {t.version}</span>
            )}
            <span className="tabular-nums">建立於 {date(t.created_at)}</span>
            <span className="tabular-nums">更新於 {ago(t.updated_at)}</span>
          </SheetDescription>

          {(t.issue_url || (!hasPrResult && t.pr_url)) && (
            <div className="flex flex-wrap gap-2">
              {t.issue_url && (
                <Button variant="outline" size="xs" asChild>
                  <a href={t.issue_url} target="_blank" rel="noreferrer">
                    Issue #{t.issue_number} <ExternalLink />
                  </a>
                </Button>
              )}
              {!hasPrResult && t.pr_url && (
                <Button variant="outline" size="xs" asChild>
                  <a href={t.pr_url} target="_blank" rel="noreferrer">
                    PR #{t.pr_number} <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
          )}
          <StationTrack
            task={t}
            labelled
            endAction={
              (t.status === "rejected" || t.status === "cancelled") && (
                <>
                  <Button
                    className="work-touch shrink-0"
                    aria-describedby={reopenHintId}
                    disabled={busy}
                    onClick={() =>
                      void act(t, "reopen", {}, "已重新開啟，請確認後再核准")
                    }
                  >
                    <RotateCcw /> 重新開啟
                  </Button>
                  <span
                    id={reopenHintId}
                    className="basis-full text-xs text-muted-foreground"
                  >
                    重新開啟後回到待審核，確認專案並核准才會派工。
                  </span>
                </>
              )
            }
          />
          {live && (
            <RunProgressLine
              run={{
                phase: live.status,
                startedAt: live.started_at,
                deadline: live.deadline,
                heartbeatAt: live.heartbeat_at,
              }}
            />
          )}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          {hasPrResult && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  修改結果
                </h3>
                {t.pr_url && (
                  <Button variant="outline" size="xs" asChild>
                    <a href={t.pr_url} target="_blank" rel="noreferrer">
                      開啟 PR #{t.pr_number} <ExternalLink />
                    </a>
                  </Button>
                )}
              </div>
              {prSummary ? (
                <QueryReport answer={prSummary} taskId={t.id} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t.status === "ready"
                    ? "你可以到 GitHub 檢視並合併這個 PR。"
                    : t.status === "merged"
                      ? "你可以到 GitHub 查看已合併的變更。"
                      : "你可以到 GitHub 查看這個 PR。"}
                </p>
              )}
            </section>
          )}
          {t.status === "answered" && resultReport}
          {title !== t.title && (
            <details className="text-sm [overflow-wrap:anywhere]">
              <summary className="cursor-pointer">查看完整標題</summary>
              <p className="mt-2">{title}</p>
            </details>
          )}
          {!!(thread?.before.length || thread?.after.length) && (
            <section
              aria-label="對話串"
              className="min-w-0 rounded-lg border p-3 text-sm"
            >
              <p className="font-semibold">對話串</p>
              <ol className="mt-2 flex flex-col gap-1">
                {[
                  ...(thread?.before ?? []).map((x) => ({
                    ...x,
                    at: "before",
                  })),
                  { id: t.id, title: t.title, status: t.status, at: "self" },
                  ...(thread?.after ?? []).map((x) => ({ ...x, at: "after" })),
                ].map((x) => (
                  <li key={x.id} className="flex min-w-0 items-center gap-2">
                    {x.at === "self" ? (
                      <span className="min-w-0 flex-1 truncate font-medium">
                        ▸ {x.title}（目前這一題）
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-primary underline-offset-2 hover:underline"
                        onClick={() => open(x.id)}
                      >
                        {x.at === "after" ? "↳ " : ""}
                        {x.title}
                      </button>
                    )}
                    <StatusBadge status={x.status} />
                  </li>
                ))}
              </ol>
            </section>
          )}
          {canRelink && (relinkOptions.length > 0 || t.parent_id) && (
            <details className="rounded-lg border px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                接錯題了？
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  你選擇上一題後會沿用它的專案與分支重新處理，選「改成新話題」則會重新確認專案。
                </p>
                <select
                  aria-label="選擇上一題"
                  className="rounded-md border bg-background px-2 py-1.5"
                  value={relinkTo}
                  onChange={(e) => setRelinkTo(e.target.value)}
                >
                  <option value="">選擇正確的上一題…</option>
                  {t.parent_id && <option value="new">改成新話題</option>}
                  {relinkOptions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy || !relinkTo}
                  onClick={() => {
                    relink(t, relinkTo === "new" ? null : relinkTo);
                    setRelinkTo("");
                  }}
                >
                  改成接在另一題後面
                </Button>
              </div>
            </details>
          )}
          <section
            aria-label="處理專案"
            className="min-w-0 rounded-lg border bg-muted/40 p-3 text-sm"
          >
            <p className="font-semibold">處理專案</p>
            <p className="mt-1 break-words">
              來自「{review?.group_name ?? groupName(state, t)}」的
              {t.mode === "query" ? "查詢" : "修改需求"}
            </p>
            <p
              ref={projectHeading}
              tabIndex={-1}
              className="mt-2 font-medium break-words"
            >
              {review?.project_name ?? "尚未指定專案"}
            </p>
            {review?.repo && (
              <p className="break-all font-mono text-xs">{review.repo}</p>
            )}
            {(t.project_id || t.target_branch) && (
              <p className="mt-1 break-all">
                目標分支：
                <code>
                  {t.target_branch ??
                    (editable ? "尚未選擇" : "歷史任務未記錄")}
                </code>
              </p>
            )}
            {t.mode === "query" && t.answer && (
              <details className="mt-2 break-all">
                <summary className="cursor-pointer">
                  查詢時的專案、分支與版本
                </summary>
                {sources?.length ? (
                  <ul>
                    {sources.map((s) => (
                      <li key={s.repo}>
                        {s.name}（{s.repo}） · {s.branch} ·{" "}
                        <code>{s.commit}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="whitespace-pre-line">
                    {report.source ??
                      [review?.project_name, t.target_branch, t.base_sha]
                        .filter(Boolean)
                        .join(" · ")}
                  </p>
                )}
              </details>
            )}
            {editable && t.project_id && !t.target_branch && (
              <p className="mt-1 text-xs text-warn">
                要先選好目標分支才能確認。請按下方「更換分支」選擇。
              </p>
            )}
            {t.branch_selection?.reason && editable && !review?.confirmed && (
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {t.branch_selection.reason}
              </p>
            )}
            {(!review?.confirmed || t.project_routing?.status === "clear") && (
              <p className="mt-2 break-words text-muted-foreground">
                {t.project_routing?.reason ?? "請確認本次需求與目標專案"}
              </p>
            )}
            {!!t.project_routing?.evidence.length && (
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {t.project_routing.evidence.map((e, i) => (
                  <li key={i} className="break-all">
                    依據：
                    {e.kind === "message"
                      ? `需求訊息 ${e.sourceId}`
                      : e.sourceId.replace(/^repo:[^:]+:[^:]+:/, "")}
                  </li>
                ))}
              </ul>
            )}
            {!!t.project_routing?.relatedProjects?.length && (
              <p className="mt-2 break-words text-xs">
                一併查詢（唯讀）：
                {t.project_routing.relatedProjects
                  .map((p) => `${p.name}（${p.repo}）`)
                  .join("、")}
              </p>
            )}
            <p className="mt-2 text-xs">
              {review?.confirmed
                ? review.confirmation?.kind === "manual"
                  ? `已由 ${review.confirmation.actor} 確認本版本`
                  : "本次查詢已通過專案證據檢查"
                : editable
                  ? "待確認專案；綁定不代表這次需求一定屬於此專案"
                  : "保留當時的專案與執行紀錄"}
            </p>
            {editable && t.project_id && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() => setAssignOpen((v) => !v)}
              >
                {assignOpen ? "取消更換專案" : "更換專案"}
              </Button>
            )}
            {editable && t.project_id && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 ml-2"
                disabled={busy}
                onClick={() => setBranchOpen((v) => !v)}
              >
                {branchOpen ? "取消更換分支" : "更換分支"}
              </Button>
            )}
            {branchOpen && editable && t.project_id && (
              <TaskBranchPicker
                key={`${t.id}:${t.version}:${t.project_id}`}
                detail={detail}
                busy={busy}
                act={act}
              />
            )}
            {editable && (!t.project_id || assignOpen) && (
              <AssignProject
                task={t}
                state={state}
                busy={busy}
                act={act}
                go={admin ? go : undefined}
                sources={detail.sources}
                onBound={() => projectHeading.current?.focus()}
              />
            )}
          </section>
          {queue && (
            <div
              role="status"
              aria-label="排隊原因"
              className="flex gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-sm text-info"
            >
              <Clock className="mt-0.5 size-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="[overflow-wrap:anywhere]">
                  排隊中（第 {queue.position} 位）：{queue.text}
                </p>
                {queue.hint && (
                  <p className="flex flex-wrap items-center gap-x-2 text-xs [overflow-wrap:anywhere]">
                    <span>建議：{queue.hint}</span>
                    {queuePage && (
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-info"
                        onClick={() => go(queuePage)}
                      >
                        {fixPageLabels[queuePage]}
                      </Button>
                    )}
                  </p>
                )}
                {queue.retry_at && queue.code !== "retry" && (
                  <p className="text-xs">
                    將於 {clock(queue.retry_at)} 自動重試
                  </p>
                )}
              </div>
            </div>
          )}
          {t.last_error && (
            <div
              className={cn(
                "flex gap-2 rounded-lg px-3 py-2.5 text-sm",
                t.last_error.startsWith("AI 等你回答") ||
                  t.status === "budget_wait"
                  ? "bg-warn-soft text-warn"
                  : retrying
                    ? "bg-info-soft text-info"
                    : "bg-danger-soft text-danger",
              )}
            >
              {retrying ? (
                <RefreshCw className="mt-0.5 size-4 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                {retrying && <p className="font-medium">上一次嘗試</p>}
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <Linkified text={t.last_error.replace(/^Error: /, "")} />
                </span>
                {quotaWaitHint && <p className="text-xs">{quotaWaitHint}</p>}
              </div>
            </div>
          )}
          {notes.length > 0 && (
            <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn">
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <ul
                className="min-w-0 list-disc space-y-0.5 pl-4 [overflow-wrap:anywhere]"
                aria-label="風險與待確認事項"
              >
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <GroupDeliveryNotes
            deliveries={detail.groupDeliveries}
            kinds={[
              t.mode === "query" ? "group_answered" : "group_no_changes",
              ...(t.status === "failed" ? ["group_failed"] : []),
              ...(t.status === "ready" ? ["group_ready"] : []),
              ...(t.status === "merged" ? ["group_merged"] : []),
              ...(t.status === "closed" ? ["group_closed"] : []),
              ...(t.status === "awaiting_approval" ? ["group_received"] : []),
            ]}
          />
          {t.status !== "answered" && resultReport}
          {canFollowup && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="followup">
                {adding ? "再改一點" : followupText.label}
              </Label>
              <Textarea
                id="followup"
                aria-describedby={followupHelpId}
                rows={3}
                maxLength={2000}
                value={ask}
                placeholder={
                  adding
                    ? "例如：按鈕顏色再深一點；錯誤訊息也寫出欄位名稱"
                    : followupText.example
                }
                onChange={(e) => setAsk(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  className="min-h-11"
                  disabled={busy || !ask.trim()}
                  onClick={async () => {
                    // 送出失敗（例如 409、連線中斷）時保留原字，離開提醒也跟著保留。
                    if (await followup(t, ask.trim())) setAsk("");
                  }}
                >
                  {adding ? "再改一點" : followupText.action}
                </Button>
                <p
                  id={followupHelpId}
                  className="min-w-0 flex-[1_1_12rem] text-xs text-muted-foreground"
                >
                  {adding
                    ? t.status === "ready"
                      ? "你確認新的一題後，修改會接在同一個 PR。"
                      : "你確認新的一題後，系統會從目標分支另開 PR。"
                    : followupText.description}
                  {adding
                    ? followupPlatform === "line" &&
                      "也可以在 LINE 引用完成通知，說明還想調整的地方。"
                    : followupPlatform && followupText[followupPlatform]}
                </p>
              </div>
            </div>
          )}
          {["awaiting_approval", "failed", "budget_wait"].includes(
            t.status,
          ) && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm">
              <span className="flex-1 text-muted-foreground">
                {t.mode === "query"
                  ? "查詢任務：只調查並回覆報告，不修改程式、不開 PR。"
                  : "修改程式：Codex 修改後經測試與審查開 PR。"}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(
                    t,
                    "mode",
                    { mode: t.mode === "query" ? "change" : "query" },
                    t.mode === "query" ? "已改為修改程式" : "已改為查詢任務",
                  )
                }
              >
                {t.mode === "query" ? "改為修改程式" : "改為查詢任務"}
              </Button>
            </div>
          )}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">需求</h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {t.summary}
            </p>
          </section>
          {visibleAcceptance.length > 0 && (
            <section
              aria-label={taskAcceptanceLabels.heading}
              className="flex flex-col gap-2"
            >
              <h3 className="text-xs font-medium text-muted-foreground">
                {taskAcceptanceLabels.heading}
              </h3>
              <ul className="list-disc space-y-1.5 pl-5">
                {visibleAcceptance.map((a, i) => (
                  <li key={i} className="text-sm [overflow-wrap:anywhere]">
                    {a}
                  </li>
                ))}
              </ul>
              {verification && (
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {verification.kind === "build"
                    ? taskAcceptanceLabels.build
                    : `${taskAcceptanceLabels.partial} ${
                        verification.limitations
                          ? taskAcceptanceLabels.uncovered(
                              verification.limitations,
                            )
                          : taskAcceptanceLabels.unknownScope
                      }`}
                </p>
              )}
            </section>
          )}
          {t.status === "awaiting_approval" && t.question && (
            <GroupDeliveryNotes
              deliveries={detail.groupDeliveries}
              kinds={["group_question"]}
            />
          )}
          <TaskClarification
            key={t.id}
            task={t}
            editable={canAmend}
            answerField={canAnswer ? answerField : null}
            busy={busy}
            act={act}
            answer={answer}
          />
          {options && (
            <section className="flex flex-col gap-2">
              <h3
                id="task-suggestions-title"
                className="text-xs font-medium text-muted-foreground"
              >
                可選方案 · 選一個後在下方派工
              </h3>
              <div
                role="radiogroup"
                aria-labelledby="task-suggestions-title"
                className="flex flex-col gap-2"
              >
                {t.suggestions.map((o, i) => (
                  <div
                    key={i}
                    className={cn(
                      "relative flex gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors hover:bg-muted/40 has-focus-visible:outline-2 has-focus-visible:outline-offset-2",
                      pick === i && "border-primary bg-primary/5",
                    )}
                  >
                    <input
                      id={`suggestion-${i}`}
                      type="radio"
                      name="task-suggestion"
                      value={i}
                      checked={pick === i}
                      onChange={() => setPick(i)}
                      aria-describedby={`suggestion-description-${i}`}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                        pick === i &&
                          "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {pick === i && <Check className="size-3" />}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <label
                        htmlFor={`suggestion-${i}`}
                        className="flex cursor-pointer items-center gap-2 text-sm font-medium after:absolute after:inset-0"
                      >
                        {o.label}
                        {o.recommended && <Badge variant="info">推薦</Badge>}
                      </label>
                      <div
                        id={`suggestion-description-${i}`}
                        className="flex flex-col gap-0.5"
                      >
                        {o.reason && (
                          <span className="text-xs text-muted-foreground">
                            {o.recommended ? "推薦理由：" : "適合情況："}
                            {o.reason}
                          </span>
                        )}
                        <span className="text-sm text-muted-foreground">
                          {o.summary}
                        </span>
                      </div>
                      {pick === i && o.acceptance.length > 0 && (
                        <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                          {o.acceptance.map((a, j) => (
                            <li key={j} className="flex gap-1.5">
                              <CheckCircle2 className="mt-px size-3.5 shrink-0" />
                              {a}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {sensitive && (
                <p className="text-xs text-muted-foreground">
                  涉及敏感範圍，不能直接採用方案；請補充需求後再核准。
                </p>
              )}
            </section>
          )}
          {canAmend && (
            <section
              id="amend-task"
              className="rounded-lg border"
              hidden={!amendOpen}
            >
              <h3 className="px-4 pt-4 text-sm font-medium">
                編輯需求與驗收條件
              </h3>
              <form
                className="flex flex-col gap-3 px-4 py-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    t,
                    "amend",
                    { summary, acceptance: lines(acceptance) },
                    "已存成新版本，請重新核准",
                  );
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {t.status === "answered"
                    ? "你儲存後會重新查詢並取代目前的回答。"
                    : "你儲存後會以新版本取代目前的需求與驗收條件。"}
                </p>
                {stale && (
                  <p
                    role="status"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn"
                  >
                    你編輯的時候，這個任務已更新到版本 {t.version}
                    ；下面仍是你還沒儲存的內容。
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-warn underline"
                      onClick={resetDraft}
                    >
                      改用最新內容
                    </Button>
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="amend-summary">需求說明</Label>
                  <Textarea
                    id="amend-summary"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    required
                    minLength={5}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="amend-acceptance">驗收條件（每行一項）</Label>
                  <Textarea
                    id="amend-acceptance"
                    value={acceptance}
                    onChange={(e) => setAcceptance(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy || !amendDirty}>
                    儲存為新版本
                  </Button>
                  {amendDirty && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={resetDraft}
                    >
                      復原
                    </Button>
                  )}
                </div>
              </form>
            </section>
          )}
          <Tabs value={tab} onValueChange={setTab} className="gap-4">
            <TabsList aria-label="任務紀錄" className="w-full">
              <TabsTrigger value="sources">
                來源訊息
                <span className="text-xs text-muted-foreground">
                  {detail.sources.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="history">時間軸</TabsTrigger>
              <TabsTrigger value="runs">
                執行紀錄
                {detail.runs.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {detail.runs.length}
                  </span>
                )}
              </TabsTrigger>
              {hasEvidence && (
                <TabsTrigger value="evidence">判讀依據</TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="sources">
              {detail.sources.length ? (
                <div className="flex flex-col gap-2">
                  {detail.sources.map((m) => (
                    <div
                      key={m.id}
                      className="self-start rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm"
                    >
                      {m.sender && (
                        <span className="mb-0.5 block text-xs font-medium text-muted-foreground">
                          {m.sender}
                        </span>
                      )}
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {m.revoked
                          ? "此訊息已撤回"
                          : (m.text ??
                            (m.type === "image"
                              ? "（圖片）"
                              : "（內容已到期）"))}
                      </p>
                      {m.has_image && !m.revoked && (
                        <img
                          className="mt-2 max-w-full rounded-lg"
                          src={`/api/messages/${m.id}/image`}
                          alt="來源圖片"
                        />
                      )}
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {date(m.received_at)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  原始內容已到期。
                </p>
              )}
            </TabsContent>
            <TabsContent value="history">
              <ol className="flex flex-col gap-3">
                {collapseRepeats(detail.history).map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 text-sm">
                    <Clamped text={a.detail} />
                    <span className="text-xs text-muted-foreground">
                      {date(a.created_at)}
                      {a.times > 1 && `・之後連續重複，共 ${a.times} 次`}
                    </span>
                  </li>
                ))}
                {!detail.history.length && (
                  <li className="text-sm text-muted-foreground">
                    還沒有紀錄。
                  </li>
                )}
              </ol>
            </TabsContent>
            <TabsContent value="runs">
              <RunObserver taskId={t.id} runs={detail.runs} />
            </TabsContent>
            {hasEvidence && (
              <TabsContent
                value="evidence"
                className="data-[state=active]:flex flex-col gap-4"
              >
                <TaskContextEvidence detail={detail} />
                {detail.references.length > 0 && (
                  <section className="min-w-0 text-sm">
                    <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                      判讀時參考的資料
                    </h3>
                    {detail.references.map((ref) => (
                      <div key={ref.id} className="mt-2 min-w-0 break-words">
                        <p>判讀時間 {date(ref.created_at)}</p>
                        {!ref.tasks.length && !ref.messages.length && (
                          <p>參考資料已到期或已移除。</p>
                        )}
                        <ul className="list-inside list-disc">
                          {ref.tasks.map((x) => (
                            <li key={x.id} className="break-all">
                              相關任務：{x.title}（{x.id.slice(0, 8)}）
                            </li>
                          ))}
                          {ref.messages.map((time, i) => (
                            <li key={i}>舊對話：{date(time)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                )}
              </TabsContent>
            )}
          </Tabs>
        </div>
        {(t.status === "awaiting_approval" ||
          ["failed", "budget_wait", "queued", "running", "reviewing"].includes(
            t.status,
          )) && (
          <SheetFooter className="shrink-0 items-center">
            {canAnswer && (
              <Button onClick={focusAnswer}>
                {taskClarificationLabels.action}
              </Button>
            )}
            {options && (
              <Button
                disabled={busy || sensitive || pick === null || !canConfirm}
                title={sensitive ? "涉及敏感範圍，請補充後再核准" : undefined}
                onClick={() =>
                  pick !== null &&
                  void act(
                    t,
                    "adopt",
                    { index: pick, ...confirmationBody },
                    `已採用方案 ${pick + 1}，開始派工`,
                  )
                }
              >
                <Check />
                {pick === null
                  ? "請先選擇方案"
                  : `確認專案與分支並採用方案 ${pick + 1}`}
              </Button>
            )}
            {deciding && !canAnswer && !options && !t.missing.length && (
              <Button
                disabled={busy || !canConfirm}
                onClick={() =>
                  void act(
                    t,
                    "approve",
                    confirmationBody,
                    "已確認專案並核准，開始排程",
                  )
                }
              >
                <Check />{" "}
                {branchOpen || assignOpen
                  ? "請先儲存目標變更"
                  : t.mode === "query"
                    ? "確認專案與分支並開始查詢"
                    : "確認專案與分支並核准修改"}
              </Button>
            )}
            {/* 失敗時主按鈕依原因：先修設定的前往頁面、逾時先修改這一題；這兩種重試降為次要。 */}
            {fixTarget && (
              <Button onClick={() => go(fixTarget, t.project_id)}>
                {fixPageLabels[fixTarget]}
              </Button>
            )}
            {amendButton}
            {t.status === "failed" && (
              <Button
                variant={fix.kind === "retry" ? "default" : "outline"}
                disabled={busy}
                onClick={() => void act(t, "retry", {}, "已重新排程")}
              >
                <RefreshCw /> 重試
              </Button>
            )}
            {[
              "awaiting_approval",
              "failed",
              "queued",
              "running",
              "reviewing",
              "budget_wait",
            ].includes(t.status) && (
              <EndTaskButton task={t} busy={busy} act={act} />
            )}
            {/* 等待額度會自動繼續：不放「重試」主按鈕；API 模式才給次要的「已提高預算，立即再試」。 */}
            <BudgetRetry task={t} state={state} busy={busy} act={act} />
            {t.status === "budget_wait" && admin && (
              <Button variant="ghost" size="sm" onClick={() => go("settings")}>
                調整額度設定
              </Button>
            )}
          </SheetFooter>
        )}
        {t.status === "answered" && (
          <SheetFooter className="shrink-0 items-center justify-between">
            <span className="flex-1 text-sm text-muted-foreground">
              {t.mode === "query"
                ? "你修改後重新查詢，會取代目前的回答。"
                : "你可以補充需求後重新送審。"}
            </span>
            {amendButton}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
