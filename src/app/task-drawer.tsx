import { useEffect, useState } from "react";
import { TaskContextEvidence } from "./context-evidence";
import { RunObserver } from "./run-observer";
import { QueryReport } from "./query-report";
import { TaskBranchPicker } from "./task-branch-picker";
import { TaskClarification } from "./task-clarification";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  FolderGit2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Label,
  Tabs,
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
import { AssignProject } from "./inbox";
import { ConfirmButton } from "./confirm";
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
  StatusBadge,
  Stepper,
} from "./shared";

export function TaskDrawer({
  detail,
  state,
  busy,
  admin,
  close,
  go,
  act,
  open,
  followup,
}: {
  detail: Detail;
  state: State;
  busy: boolean;
  admin: boolean;
  close: () => void;
  go: (v: View) => void;
  act: Act;
  /** 開啟對話串中的另一題。 */
  open: (id: string) => void;
  /** 對已回答的查詢追問，建立新的一題。 */
  followup: (t: Detail["task"], text: string) => unknown;
}) {
  const t = detail.task;
  const notes = [...t.risk_reasons, ...(t.question ? [] : t.missing)];
  const editable = [
    "awaiting_approval",
    "queued",
    "failed",
    "budget_wait",
  ].includes(t.status);
  // 查詢回覆後也能改需求再查一次；其餘已結束的任務不能改。
  const canAmend = editable || t.status === "answered";
  const saved = { summary: t.summary, acceptance: t.acceptance.join("\n") };
  const [summary, setSummary] = useState(saved.summary);
  const [acceptance, setAcceptance] = useState(saved.acceptance);
  // 草稿是從哪個版本開始寫的；任務在背景更新時用來判斷要不要保留草稿。
  const [base, setBase] = useState({ version: t.version, ...saved });
  const [amendOpen, setAmendOpen] = useState(false);
  const [ask, setAsk] = useState("");
  useUnsaved("task-followup", ask.trim().length > 0);
  const canFollowup = t.mode === "query" && t.status === "answered";
  const thread = detail.thread;
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
  const [tab, setTab] = useState("sources");
  const [copied, setCopied] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
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
  const hasEvidence =
    detail.contextEvidence.length > 0 ||
    detail.images.length > 0 ||
    detail.references.length > 0;
  const openAmend = () => {
    setAmendOpen(true);
    requestAnimationFrame(() =>
      document
        .getElementById("amend-summary")
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };
  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <StatusBadge status={t.status} />
            <Badge variant={t.mode === "query" ? "info" : "secondary"}>
              {t.mode === "query" ? "查詢任務" : "修改程式"}
            </Badge>
            <SheetDescription className="flex flex-wrap items-center gap-x-1.5">
              <span>{groupName(state, t)}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <FolderGit2 className="size-3.5" />
                {projectName(state, t)}
              </span>
              <span aria-hidden>·</span>
              <span>版本 {t.version}</span>
              <span aria-hidden>·</span>
              <span>
                建立於 {date(t.created_at)}・更新於 {ago(t.updated_at)}
              </span>
            </SheetDescription>
          </div>
          <SheetTitle className="text-lg leading-snug">{t.title}</SheetTitle>

          {(t.issue_url || t.pr_url) && (
            <div className="flex flex-wrap gap-2">
              {t.issue_url && (
                <Button variant="outline" size="xs" asChild>
                  <a href={t.issue_url} target="_blank" rel="noreferrer">
                    Issue #{t.issue_number} <ExternalLink />
                  </a>
                </Button>
              )}
              {t.pr_url && (
                <Button variant="outline" size="xs" asChild>
                  <a href={t.pr_url} target="_blank" rel="noreferrer">
                    PR #{t.pr_number} <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
          )}
          <Stepper status={t.status} query={t.mode === "query"} />
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-5">
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
          <section
            aria-label="處理專案"
            className="min-w-0 rounded-lg border bg-muted/40 p-3 text-sm"
          >
            <p className="font-semibold">處理專案</p>
            <p className="mt-1 break-words">
              聊天室：{review?.group_name ?? groupName(state, t)}・
              {t.mode === "query" ? "查詢" : "修改程式"}
            </p>
            <p className="mt-2 font-medium break-words">
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
            {editable && (
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
          </section>
          {t.last_error && (
            <p
              className={`flex gap-2 rounded-lg px-3 py-2.5 text-sm ${t.last_error.startsWith("AI 等你回答") ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger"}`}
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                <Linkified text={t.last_error.replace(/^Error: /, "")} />
              </span>
            </p>
          )}
          {notes.length > 0 && (
            <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div className="flex flex-col gap-0.5">
                {notes.map((r, i) => (
                  <p key={i}>{r}</p>
                ))}
              </div>
            </div>
          )}
          {t.answer && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  調查結果
                </h3>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(t.answer ?? "")
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
                answer={t.answer}
                taskId={t.id}
                images={detail.reportImages}
              />
            </section>
          )}
          {canFollowup && (
            <section aria-label="追問" className="flex flex-col gap-2">
              <Label htmlFor="followup">接著問</Label>
              <Textarea
                id="followup"
                rows={3}
                maxLength={2000}
                value={ask}
                placeholder="例如：那 ch3 呢？剛剛說的那張表有哪些欄位？"
                onChange={(e) => setAsk(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                會建立新的一題，沿用這一題的專案與分支，並帶著前面的問答查詢；這裡的回答不會被取代。也可以在
                LINE 用「回覆」引用機器人的回答接著問。
              </p>
              <div>
                <Button
                  disabled={busy || !ask.trim()}
                  onClick={async () => {
                    await followup(t, ask.trim());
                    setAsk("");
                  }}
                >
                  追問
                </Button>
              </div>
            </section>
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
          {editable && (!t.project_id || assignOpen) && (
            <div className="rounded-lg border p-4">
              <AssignProject
                task={t}
                state={state}
                busy={busy}
                act={act}
                go={admin ? go : undefined}
              />
            </div>
          )}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">需求</h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {t.summary}
            </p>
          </section>
          {t.acceptance.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                驗收條件
              </h3>
              <ul className="flex flex-col gap-1.5">
                {t.acceptance.map((a, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    {a}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <TaskClarification
            key={t.id}
            task={t}
            editable={canAmend}
            busy={busy}
            act={act}
            amend={openAmend}
          />
          {options && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                可選方案 · 選一個後在下方派工
              </h3>
              <div role="radiogroup" className="flex flex-col gap-2">
                {t.suggestions.map((o, i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={pick === i}
                    onClick={() => setPick(i)}
                    className={cn(
                      "flex gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors hover:bg-muted/40",
                      pick === i && "border-primary bg-primary/5",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                        pick === i &&
                          "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {pick === i && <Check className="size-3" />}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {o.label}
                        {o.recommended && <Badge variant="info">推薦</Badge>}
                      </span>
                      {o.reason && (
                        <span className="text-xs text-muted-foreground">
                          {o.recommended ? "推薦理由：" : "適合情況："}
                          {o.reason}
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {o.summary}
                      </span>
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
                    </span>
                  </button>
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
            <details
              className="rounded-lg border"
              open={amendOpen}
              onToggle={(e) => setAmendOpen(e.currentTarget.open)}
            >
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                {t.status === "answered"
                  ? "修改問題重新查詢（會取代目前的回答）"
                  : t.missing.length
                    ? "自己補充需求"
                    : "修改需求"}
                {amendDirty && (
                  <span className="ml-2 text-xs font-normal text-warn">
                    尚未儲存
                  </span>
                )}
              </summary>
              <form
                className="flex flex-col gap-3 border-t px-4 py-4"
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
            </details>
          )}
          <Tabs value={tab} onValueChange={setTab} className="gap-4">
            <TabsList className="w-full">
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
            {tab === "sources" &&
              (detail.sources.length ? (
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
              ))}
            {tab === "history" && (
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
            )}
            {tab === "runs" && <RunObserver taskId={t.id} runs={detail.runs} />}
            {tab === "evidence" && hasEvidence && (
              <div className="flex flex-col gap-4">
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
              </div>
            )}
          </Tabs>
        </div>
        {(t.status === "awaiting_approval" ||
          ["failed", "budget_wait", "queued", "running", "reviewing"].includes(
            t.status,
          )) && (
          <SheetFooter className="items-center">
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
            {deciding && !options && !t.missing.length && (
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
            {deciding && t.missing.length > 0 && (
              <Button
                variant={options ? "ghost" : "default"}
                onClick={openAmend}
              >
                {options ? "都不是，自己補充" : "補充需求"}
              </Button>
            )}
            {t.status === "awaiting_approval" && (
              <ConfirmButton
                variant="outline"
                className="ml-auto"
                disabled={busy}
                title="拒絕這個需求？"
                description="拒絕後不會派工；之後反悔，可以在這個任務按「重新開啟」。"
                confirm="拒絕需求"
                onConfirm={() => act(t, "reject", {}, "已拒絕需求")}
              >
                拒絕
              </ConfirmButton>
            )}
            {["failed", "budget_wait"].includes(t.status) && (
              <Button
                disabled={busy}
                onClick={() => void act(t, "retry", {}, "已重新排程")}
              >
                <RefreshCw /> 重試
              </Button>
            )}
            {t.status === "failed" ? (
              <ConfirmButton
                variant="ghost"
                className="ml-auto"
                disabled={busy}
                title="關閉這個任務？"
                description="關閉後不再重試，會從「需要你處理」移除；之後要做，可以在這個任務按「重新開啟」。"
                confirm="關閉任務"
                onConfirm={() => act(t, "cancel", {}, "已關閉任務")}
              >
                關閉任務
              </ConfirmButton>
            ) : (
              ["queued", "running", "reviewing", "budget_wait"].includes(
                t.status,
              ) && (
                <ConfirmButton
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  title="取消這個任務？"
                  description="進行中的工作會停止，不會開 PR；之後要做，可以在這個任務按「重新開啟」。"
                  confirm="取消任務"
                  onConfirm={() => act(t, "cancel", {}, "已取消任務")}
                >
                  取消任務
                </ConfirmButton>
              )
            )}
          </SheetFooter>
        )}
        {/* 已結束或等合併的任務：說明現在能做什麼，不再是一片空白。 */}
        {["rejected", "cancelled"].includes(t.status) && (
          <SheetFooter className="items-center">
            <span className="flex-1 text-sm text-muted-foreground">
              重新開啟後回到待審核，確認專案並核准才會派工。
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void act(t, "reopen", {}, "已重新開啟，請確認後再核准")
              }
            >
              <RotateCcw /> 重新開啟
            </Button>
          </SheetFooter>
        )}
        {["ready", "merged", "closed", "answered"].includes(t.status) && (
          <SheetFooter className="items-center">
            <span className="flex-1 text-sm text-muted-foreground">
              {t.status === "ready"
                ? "PR 已建立，請到 GitHub 檢視與合併；合併或關閉後這裡會自動更新。要再調整，請在群組提出新需求。"
                : t.status === "merged"
                  ? "PR 已合併，任務完成。要再調整，請在群組提出新需求。"
                  : t.status === "closed"
                    ? "PR 沒有合併就關閉了（儲存庫被移除時也會這樣）。要重做，請在群組提出新需求。"
                    : "查詢已回覆。要接著問，請用上方的「接著問」；想換個問法整個重查，才用「修改問題重新查詢」，原回答會被取代。"}
            </span>
            {t.status === "answered" ? (
              <Button variant="outline" onClick={openAmend}>
                修改問題重新查詢
              </Button>
            ) : (
              t.pr_url && (
                <Button variant="outline" asChild>
                  <a href={t.pr_url} target="_blank" rel="noreferrer">
                    開啟 PR #{t.pr_number} <ExternalLink />
                  </a>
                </Button>
              )
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
