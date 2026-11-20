import { projectLabels, projectStatus } from "../../shared/status-glossary.js";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Brain,
  FolderGit2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Knowledge, Project } from "../../shared/types.js";
import { indexPathsFromForm, validIndexPath } from "../../shared/repo-scope.js";
import type { BranchCatalog } from "../../shared/task-branch.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  Checkbox,
  Label,
  Separator,
  Textarea,
} from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type Request,
  type Run,
  type State,
  Empty,
  date,
  message,
} from "./shared";
import {
  configChanged as settingsChanged,
  offersValidation,
  repoListStatus,
  takenRepos,
  validateLabel,
  validationErrorParts,
  validationKind,
} from "./project-form";
import { InstallReviewList } from "./egress";
import { ConfirmButton } from "./confirm";
import { ProjectSsh } from "./project-ssh";
import { useUnsaved, useGuard } from "./unsaved";
import { ProjectContextEditor } from "./project-context";
import { ProjectDatabase } from "./project-database";
import { isRepoNotice, verificationLabel } from "../../shared/project-setup.js";
import {
  DEFAULT_COLLECT_EXCLUDES,
  MAX_COLLECT_EXCLUDES,
  effectiveCollectExcludes,
  validCollectExclude,
} from "../../shared/build-output.js";

export const emptyProject: Partial<Project> = {
  name: "",
  repo: "",
  description: "",
  base_branch: "main",
  image: "line-agentflow-worker:local",
  setup_mode: "auto",
  sql_server: "auto",
  install_command: "",
  test_command: "",
  sensitive_paths: [],
  index_paths: [],
  collect_excludes: [],
  enabled: false,
};

function indexStatus(project: Project, enabled: boolean) {
  if (!enabled) return "未啟用";
  switch (project.index_phase) {
    case "ready":
      return `${project.index_paths?.length ? "所選範圍" : "全儲存庫可索引文字"}已完成（${project.index_chunks} 段）`;
    case "failed":
      return project.index_error ?? "索引失敗";
    case "limited":
      return project.index_error ?? "索引超過上限；未發布部分索引";
    case "indexing":
      return "索引中";
    case "queued":
      return "已排程";
    default:
      return "待建立";
  }
}
export function ProjectsView({
  state,
  busy,
  run,
  request,
  edit,
  focusId = null,
  focused,
}: {
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  edit: (p: Partial<Project>) => void;
  /** 剛存好的專案：打開它的詳情（從詳情按「編輯設定」進來的也回到同一個詳情），打開後呼叫 focused 清掉。 */
  focusId?: string | null;
  focused?: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const guard = useGuard();
  useEffect(() => {
    if (!focusId) return;
    setOpenId(focusId);
    focused?.();
  }, [focusId]);
  const open = state.projects.find((p) => p.id === openId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          共 {state.projects.length} 個專案，
          {
            state.projects.filter(
              (p) =>
                projectStatus(
                  p,
                  state.groups.some((g) => g.project_ids.includes(p.id)),
                  validationFailed(p),
                ) === "ready",
            ).length
          }{" "}
          個{projectLabels.ready}
        </p>
        <Button onClick={() => edit(emptyProject)}>
          <Plus /> 新增專案
        </Button>
      </div>
      {state.projects.length ? (
        <Card className="gap-0 py-0">
          <div className="hidden grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.2fr)_minmax(0,1.2fr)_7.5rem] gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground md:grid">
            <span>專案</span>
            <span>分支</span>
            <span>環境驗證</span>
            <span>使用群組</span>
            <span className="text-right">狀態</span>
          </div>
          <ul className="divide-y">
            {state.projects.map((p) => {
              const groups = state.groups.filter((g) =>
                g.project_ids.includes(p.id),
              );
              return (
                <li key={p.id}>
                  <button
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.2fr)_minmax(0,1.2fr)_7.5rem]"
                    onClick={() => setOpenId(p.id)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {p.repo}
                      </span>
                    </span>
                    <span className="hidden truncate text-sm md:block">
                      {p.base_branch}
                    </span>
                    <span
                      className={cn(
                        "hidden truncate text-sm md:block",
                        p.setup_mode !== "auto" &&
                          !p.test_command &&
                          "text-warn",
                        p.setup_mode !== "auto" &&
                          validationFailed(p) &&
                          "text-danger",
                      )}
                    >
                      {p.setup_mode === "auto" ? (
                        p.setup_status || "AI 自動設定"
                      ) : validationFailed(p) ? (
                        <>
                          {projectLabels.failed}
                          {p.test_command && (
                            <>
                              {" · "}
                              <code className="text-xs">{p.test_command}</code>
                            </>
                          )}
                        </>
                      ) : p.test_command ? (
                        <code className="text-xs">{p.test_command}</code>
                      ) : (
                        "未設定"
                      )}
                    </span>
                    <span className="hidden truncate text-sm text-muted-foreground md:block">
                      {groups.map((g) => g.name).join("、") || "—"}
                    </span>
                    <span className="flex justify-end">
                      <ProjectBadge
                        project={p}
                        bound={state.groups.some((g) =>
                          g.project_ids.includes(p.id),
                        )}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : (
        <Card>
          <Empty icon={<FolderGit2 />} title="還沒有專案">
            先把 GitHub App 安裝到儲存庫，再新增專案。
          </Empty>
        </Card>
      )}
      {open && (
        <Sheet open onOpenChange={(o) => !o && guard(() => setOpenId(null))}>
          <SheetContent className="sm:max-w-xl">
            <SheetHeader>
              <div className="flex items-center gap-2">
                <ProjectBadge
                  project={open}
                  bound={state.groups.some((g) =>
                    g.project_ids.includes(open.id),
                  )}
                />
              </div>
              <SheetTitle className="text-lg">{open.name}</SheetTitle>
              <SheetDescription asChild>
                <a
                  className="inline-flex w-fit items-center gap-1 font-mono text-xs hover:text-foreground"
                  href={`https://github.com/${open.repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {open.repo} <ArrowUpRight className="size-3" />
                </a>
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
              <p
                className={
                  open.description ? "text-sm" : "text-sm text-muted-foreground"
                }
              >
                {open.description || "尚未填寫說明，AI 只能依檔案結構判斷。"}
              </p>
              <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">環境設定</dt>
                <dd>
                  {open.setup_mode === "auto" ? "AI 自動設定" : "手動指定"}
                </dd>
                <dt className="text-muted-foreground">分支</dt>
                <dd>{open.base_branch}</dd>
                <dt className="text-muted-foreground">安裝命令</dt>
                <dd className="min-w-0 break-all">
                  {(
                    open.setup_mode === "auto"
                      ? open.setup_plan?.install
                      : open.install_command
                  ) ? (
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {open.setup_mode === "auto"
                        ? open.setup_plan?.install
                        : open.install_command}
                    </code>
                  ) : open.setup_mode === "auto" ? (
                    open.setup_plan ? (
                      "不需安裝"
                    ) : (
                      "驗證時由 AI 判斷"
                    )
                  ) : (
                    "未設定"
                  )}
                </dd>
                <dt className="text-muted-foreground">測試命令</dt>
                <dd className="min-w-0 break-all">
                  {(
                    open.setup_mode === "auto"
                      ? open.setup_plan?.test
                      : open.test_command
                  ) ? (
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {open.setup_mode === "auto"
                        ? open.setup_plan?.test
                        : open.test_command}
                    </code>
                  ) : (
                    <span className="text-warn">
                      {open.setup_mode === "auto"
                        ? "驗證時由 AI 判斷"
                        : "未設定（只靠審查）"}
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">索引</dt>
                <dd className="min-w-0 break-words">
                  {indexStatus(open, state.settings.rag_enabled)}
                </dd>
                <dt className="text-muted-foreground">範圍</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-all text-xs">
                  {open.index_paths?.length
                    ? open.index_paths.join("\n")
                    : "全儲存庫可索引文字"}
                </dd>
                <dt className="text-muted-foreground">群組</dt>
                <dd>
                  {state.groups
                    .filter((g) => g.project_ids.includes(open.id))
                    .map((g) => g.name)
                    .join("、") || "—"}
                </dd>
              </dl>
              {open.repo_missing_at && (
                <div className="flex flex-col gap-1 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
                  <span className="font-medium">
                    {open.validation_error || "GitHub 上找不到這個儲存庫"}
                  </span>
                  <span className="text-xs">
                    {date(open.repo_missing_at)}{" "}
                    發現。可能是儲存庫已刪除、搬到還沒安裝 GitHub App
                    的帳號或組織，或 GitHub App
                    被移出這個儲存庫。專案先停用，並暫時從群組解除綁定
                    {missingGroups(open, state)}。
                  </span>
                  <span className="text-xs">
                    如果是搬家或改名：把 GitHub App
                    安裝到新的帳號或組織後，系統會自動接回並恢復原本的設定，也可以按「重新檢查」馬上找一次；要換成另一個儲存庫，按「編輯設定」改選。確定不再使用就刪除專案。
                  </span>
                </div>
              )}
              {open.setup_status && (
                <p role="status" className="rounded bg-muted p-3 text-sm">
                  {open.setup_status}
                </p>
              )}
              {open.setup_plan && open.setup_mode === "auto" && (
                <div className="space-y-2 text-sm">
                  {verificationLabel(open.setup_plan).caution && (
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-warn">
                        {verificationLabel(open.setup_plan).caution}
                      </p>
                      {/* 推測結構代表驗證當下還沒有結構快照；擷取快照會讓設定作廢、重新驗證。 */}
                      {open.setup_plan.dataSource === "inferred" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={jumpToDatabase}
                        >
                          登記資料庫連線
                        </Button>
                      )}
                    </div>
                  )}
                  {open.setup_plan.sqlServer && (
                    <p>
                      測試用 SQL Server：
                      {open.setup_plan.sqlServer.source === "admin"
                        ? "管理者設定一律提供"
                        : "依專案判斷需要"}
                      ，使用映像 {open.setup_plan.sqlServer.image}
                    </p>
                  )}
                  <p className="whitespace-pre-line">
                    {open.setup_plan.explanation}
                  </p>
                  {open.setup_plan.systemInstall && (
                    <div className="rounded-lg border p-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        系統套件（安裝前審查）
                      </p>
                      <InstallReviewList
                        review={open.setup_plan.systemInstall}
                      />
                    </div>
                  )}
                  {!!open.setup_plan.omissions?.length && (
                    <div className="text-xs text-muted-foreground">
                      <p>以下檔案只提供摘錄或未讀取：</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">
                        {open.setup_plan.omissions.map((o, i) => (
                          <li key={i} className="break-all">
                            {o.path}：{o.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      查看 AI 設定依據
                    </summary>
                    <p className="mt-2 break-all">
                      分支：{open.setup_plan.branch} · 版本：
                      {open.setup_plan.sha.slice(0, 8)}
                      {` · 本次參考專案資訊：設定版本 ${open.setup_plan.configVersion}`}
                    </p>
                    {open.setup_plan.evidence.map((e, i) => (
                      <div key={i} className="mt-2">
                        <p className="break-all">{e.path}</p>
                        <pre className="whitespace-pre-wrap break-all">
                          {e.quote}
                        </pre>
                      </div>
                    ))}
                  </details>
                </div>
              )}
              {open.validation_error && !open.repo_missing_at && (
                <ValidationError
                  text={open.validation_error}
                  // 已驗證的專案重新驗證遇到暫時性問題時沿用先前的設定；儲存庫接回後的
                  // 「請重新驗證」也只是提醒。這兩種都不算失敗。
                  tone={
                    isRepoNotice(open.validation_error)
                      ? "notice"
                      : open.validated_at
                        ? "transient"
                        : "failed"
                  }
                />
              )}
              <Separator />
              <section
                className="flex flex-col gap-2"
                aria-labelledby="full-access-title"
              >
                <div className="flex items-center gap-2">
                  <h3 id="full-access-title" className="text-sm font-medium">
                    完全存取
                  </h3>
                  <Badge variant={open.full_access ? "warn" : "secondary"}>
                    {open.full_access ? "已開啟" : "關閉"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  你開啟後，這個專案的 AI 可以連到內網與已登記的資料庫、SSH
                  主機。
                </p>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">說明</summary>
                  <div className="mt-1">
                    開啟後，這個專案的安裝、開發、測試與審查都能連公司內網、Tailscale
                    與網際網路，Codex 與測試也拿得到下方登記的資料庫連線與 SSH
                    主機（權限照登記的帳號），就像在這台伺服器上開發。仍在容器裡執行，拿不到
                    chat2pr 自己的機密；修改仍要你核准，PR
                    仍由你合併。這台伺服器本身連不到的網路（例如沒有 VPN
                    的廠內網段），開了也連不到。
                  </div>
                </details>
                <div>
                  {open.full_access ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            request(
                              `/api/projects/${open.id}/full-access`,
                              "PUT",
                              {
                                enabled: false,
                              },
                            ),
                          "已關閉完全存取",
                        )
                      }
                    >
                      關閉完全存取
                    </Button>
                  ) : (
                    <ConfirmButton
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      title={`開啟「${open.name}」的完全存取？`}
                      description="AI 會在每個階段直接連公司內網、Tailscale 與網際網路，並用登記的資料庫帳號與 SSH 主機連真實系統；帳號能寫入，AI 就可能寫入。建議登記只有必要權限的帳號。開啟與關閉都會寫進活動紀錄。"
                      confirm="開啟完全存取"
                      onConfirm={() =>
                        run(
                          () =>
                            request(
                              `/api/projects/${open.id}/full-access`,
                              "PUT",
                              {
                                enabled: true,
                              },
                            ),
                          "已開啟完全存取",
                        )
                      }
                    >
                      開啟完全存取
                    </ConfirmButton>
                  )}
                </div>
              </section>
              <Separator />
              <ProjectContextEditor
                key={open.id}
                project={open}
                busy={busy}
                run={run}
                request={request}
              />
              <Separator />
              <ProjectDatabase
                key={`database-${open.id}`}
                project={open}
                busy={busy}
                run={run}
                request={request}
              />
              <Separator />
              <ProjectSsh
                key={`ssh-${open.id}`}
                project={open}
                busy={busy}
                run={run}
                request={request}
              />
              <Separator />
              <ProjectKnowledge
                project={open}
                state={state}
                busy={busy}
                run={run}
                request={request}
              />
            </div>
            <SheetFooter>
              <Button
                onClick={() =>
                  guard(() => {
                    setOpenId(null);
                    edit(open);
                  })
                }
              >
                編輯設定
              </Button>
              <Button
                variant="outline"
                disabled={busy || !!open.setup_input}
                onClick={() =>
                  void run(
                    () => request(`/api/projects/${open.id}/validate`, "POST"),
                    "已開始驗證環境，通過後會自動啟用派工",
                  )
                }
              >
                <RefreshCw /> {validateLabel(open)}
              </Button>
              {open.repo_missing_at && (
                <ConfirmButton
                  variant="destructive"
                  disabled={busy}
                  title={`刪除專案「${open.name}」？`}
                  description="專案設定、專案記憶與程式碼索引會一併刪除，無法復原；已經做過的任務紀錄會保留。"
                  confirm="刪除專案"
                  onConfirm={() =>
                    run(async () => {
                      await request(`/api/projects/${open.id}`, "DELETE");
                      setOpenId(null);
                    }, `已刪除專案「${open.name}」`)
                  }
                >
                  <Trash2 /> 刪除專案
                </ConfirmButton>
              )}
            </SheetFooter>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

// 找不到儲存庫時記下的群組；接回後會自動綁回去，先讓管理者知道是哪些。
function missingGroups(p: Project, state: State) {
  const names = (p.repo_missing_state?.groups ?? [])
    .map((id) => state.groups.find((g) => g.id === id)?.name)
    .filter(Boolean);
  return names.length ? `（${names.join("、")}），接回後會自動綁回去` : "";
}

// 沒有通過驗證、而且留有失敗原因；儲存庫接回後的「請重新驗證」提醒不算失敗。
const validationFailed = (p: Project) => validationKind(p) === "failed";

// 「登記資料庫連線」按鈕：捲到詳情裡的資料庫連線區塊並聚焦第一個欄位。
function jumpToDatabase() {
  const section = document.getElementById("project-database");
  section?.scrollIntoView({ behavior: "smooth", block: "start" });
  section
    ?.querySelector<HTMLElement>(
      "input:enabled, textarea:enabled, button:enabled",
    )
    ?.focus({ preventScroll: true });
}

function ValidationError({
  text,
  tone,
}: {
  text: string;
  tone: "failed" | "transient" | "notice";
}) {
  const { headline, body, detail, advice } = validationErrorParts(text);
  return (
    <div
      role={tone === "failed" ? "alert" : "status"}
      className={cn(
        "space-y-1 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs",
        tone === "failed"
          ? "bg-danger-soft text-danger"
          : "bg-warn-soft text-warn",
      )}
    >
      <p className="text-sm font-medium">
        {tone === "transient" ? `上次重新驗證未完成：${headline}` : headline}
      </p>
      {body.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {detail.length > 0 && (
        <details>
          <summary className="cursor-pointer">錯誤重點</summary>
          <p className="mt-1 font-mono">{detail.join("\n")}</p>
        </details>
      )}
      {advice.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}

// 可派工還要有群組使用；沒有群組綁定的專案收不到任何需求。
function ProjectBadge({
  project: p,
  bound,
}: {
  project: Project;
  bound: boolean;
}) {
  const status = projectStatus(p, bound, validationFailed(p));
  const variant = {
    missing: "danger",
    question: "warn",
    failed: "danger",
    unverified: "warn",
    disabled: "info",
    unbound: "secondary",
    ready: "good",
  } as const;
  const title =
    status === "missing"
      ? "GitHub 上找不到儲存庫，請檢查儲存庫位置與 GitHub App 權限。"
      : status === "failed"
        ? validationErrorParts(p.validation_error ?? "").headline
        : status === "unbound"
          ? "到群組管理勾選這個專案後才會收到需求"
          : undefined;
  return (
    <Badge variant={variant[status]} title={title}>
      {projectLabels[status]}
    </Badge>
  );
}

const knowledgeStatus: Record<Knowledge["status"], string> = {
  pending: "準備寫入",
  in_pr: "PR 待合併",
  merged: "已寫入 AGENTS.md",
  closed: "PR 已關閉",
};
function ProjectKnowledge({
  project: p,
  state,
  busy,
  run,
  request,
}: {
  project: Project;
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
}) {
  const [text, setText] = useState("");
  const items = state.knowledge.filter((k) => k.project_id === p.id);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
        <Brain className="size-4" /> 專案記憶
        <span className="font-normal text-muted-foreground">
          開發規範與背景知識，寫進 AGENTS.md 後每次開發都會遵守
        </span>
      </h3>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((k) => (
            <li
              key={k.id}
              className="flex items-center gap-2 rounded-lg bg-muted/60 py-2 pr-1 pl-3"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm">{k.content}</span>
                <span className="text-xs text-muted-foreground">
                  {k.source === "chat" ? "群組對話" : "管理者"} ·{" "}
                  {k.pr_url ? (
                    <a
                      className="underline"
                      href={k.pr_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {knowledgeStatus[k.status]}
                    </a>
                  ) : (
                    knowledgeStatus[k.status]
                  )}
                </span>
              </span>
              <ConfirmButton
                variant="ghost"
                size="icon-sm"
                aria-label="刪除專案記憶"
                disabled={busy}
                title="刪除這條專案記憶？"
                description={
                  k.status === "merged"
                    ? "這裡刪除後不能復原；已寫入 AGENTS.md 的內容不會跟著移除，需要在儲存庫中修改。"
                    : "刪除後 Codex 開發這個專案時不會再參考它，也不能復原。"
                }
                confirm="刪除記憶"
                onConfirm={() =>
                  run(
                    () => request(`/api/knowledge/${k.id}`, "DELETE"),
                    "已刪除專案記憶",
                  )
                }
              >
                <Trash2 />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await request(`/api/projects/${p.id}/knowledge`, "POST", {
              content: text,
            });
            setText("");
          }, "已新增，稍後會開 PR 寫進 AGENTS.md");
        }}
      >
        <Input
          placeholder="例：前端不要用 jQuery；日期一律用民國年"
          value={text}
          onChange={(e) => setText(e.target.value)}
          minLength={2}
          required
        />
        <Button variant="outline" disabled={busy}>
          <Plus /> 新增
        </Button>
      </form>
    </div>
  );
}

/** 基底分支：從 GitHub 列出實際存在的分支；清單拿不到或不完整時仍可手動輸入。 */
function BaseBranchField({
  repo,
  value,
  onChange,
  request,
}: {
  repo: string;
  value: string;
  onChange: (name: string) => void;
  request: Request;
}) {
  const [catalog, setCatalog] = useState<BranchCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setCatalog(null);
    setFailed(false);
    if (!repo) return;
    let live = true;
    void request<BranchCatalog>(
      `/api/repositories/branches?repo=${encodeURIComponent(repo)}`,
    )
      .then((c) => {
        if (live) setCatalog(c);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [repo, request, reload]);
  if (failed)
    return (
      <>
        <Input
          id="pf-branch"
          value={value}
          maxLength={200}
          onChange={(e) => onChange(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground" role="status">
          無法從 GitHub 取得分支清單，請直接輸入分支名稱。{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setReload((v) => v + 1)}
          >
            重新取得
          </button>
        </p>
      </>
    );
  if (!catalog)
    return (
      <Select disabled>
        <SelectTrigger id="pf-branch" className="w-full">
          <SelectValue
            placeholder={repo ? "正在取得分支…" : "請先選擇儲存庫"}
          />
        </SelectTrigger>
      </Select>
    );
  // 目前的設定不在清單內也要看得到，不能默默換掉；GitHub 預設分支排在最前面。
  const missing = !!value && !catalog.names.includes(value);
  const names = [
    ...(missing ? [value] : []),
    ...catalog.names.filter((n) => n === catalog.defaultBranch),
    ...catalog.names.filter((n) => n !== catalog.defaultBranch),
  ];
  return (
    <>
      {/* 選項還沒掛上時，元件會先送出一次空值；空字串不是分支，不能蓋掉目前的設定。 */}
      <Select value={value} onValueChange={(name) => name && onChange(name)}>
        <SelectTrigger id="pf-branch" className="w-full min-w-0">
          <SelectValue placeholder="選擇分支" />
        </SelectTrigger>
        <SelectContent>
          {names.map((n) => (
            <SelectItem key={n} value={n}>
              <span className="break-all">{n}</span>
              {n === catalog.defaultBranch && (
                <span className="text-xs text-muted-foreground">
                  GitHub 預設
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {catalog.truncated ? (
        <>
          <p className="text-xs text-muted-foreground">
            分支較多，清單只列出前 500 個；不在清單內的可以直接輸入完整名稱。
          </p>
          <Input
            aria-label="基底分支名稱"
            value={value}
            maxLength={200}
            onChange={(e) => onChange(e.target.value)}
            required
          />
        </>
      ) : (
        missing && (
          <p className="text-xs text-danger" role="alert">
            GitHub 上找不到分支「{value}」，請改選現有的分支。
          </p>
        )
      )}
    </>
  );
}

export function ProjectForm({
  project: p,
  busy,
  save,
  request,
}: {
  project: Partial<Project>;
  busy: boolean;
  /** validate 為真：存檔成功後接著排入環境驗證（「儲存並驗證環境」）。 */
  save: (p: unknown, validate: boolean) => unknown;
  request: Request;
}) {
  const [repos, setRepos] = useState<
    { full_name: string; default_branch: string; description: string }[] | null
  >(null);
  // 讀取失敗和「真的沒有儲存庫」分開：金鑰或連線問題不能被說成沒安裝 App。
  const [reposError, setReposError] = useState("");
  const [reposReload, setReposReload] = useState(0);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [scopeError, setScopeError] = useState("");
  const [excludeError, setExcludeError] = useState("");
  const [form, setForm] = useState({
    repo: p.repo ?? "",
    name: p.name ?? "",
    description: p.description ?? "",
    base_branch: p.base_branch ?? "main",
    image: p.image ?? "line-agentflow-worker:local",
    setup_mode: p.setup_mode ?? (p.id ? "manual" : "auto"),
    sql_server: p.sql_server ?? "auto",
    install_command: p.install_command ?? "",
    test_command: p.test_command ?? "",
    sensitive_paths: p.sensitive_paths?.join("\n") ?? "",
    index_paths: p.index_paths?.join("\n") ?? "",
    collect_excludes: p.collect_excludes?.join("\n") ?? "",
    enabled: !!p.enabled,
  });
  const set = (k: keyof typeof form, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));
  // 表單打開時的內容；有改動就讓關閉側邊欄、換頁前先問一次。
  const [initial] = useState(form);
  useUnsaved("project", JSON.stringify(form) !== JSON.stringify(initial));
  // 找不到儲存庫的專案可以改選；其他既有專案不能換儲存庫。
  const pickRepo = !p.id || !!p.repo_missing_at;
  useEffect(() => {
    if (!pickRepo) return;
    let active = true;
    setRepos(null);
    setReposError("");
    void request<NonNullable<typeof repos>>("/api/repositories")
      .then((list) => active && setRepos(list))
      .catch((e) => active && setReposError(message(e)));
    // 已被其他專案使用的儲存庫標「已加入」並停用。表單由 App.tsx 開啟、拿不到看板 state，
    // 所以另外讀一次精簡的 /api/state；讀不到時只少了標示，資料庫的唯一限制仍會擋下重複。
    void request<{ projects: Pick<Project, "id" | "repo">[] }>(
      "/api/state?tasks=1&activity=1",
    )
      .then((s) => active && setTaken(takenRepos(s.projects, p.id)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pickRepo, request, reposReload]);
  // 依擁有者（個人或組織）分組，組內只顯示儲存庫名稱，清單才不會擠成一長串。
  const owners = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof repos>>();
    for (const r of repos ?? []) {
      const owner = r.full_name.split("/")[0];
      groups.set(owner, [...(groups.get(owner) ?? []), r]);
    }
    const byName = (a: string, b: string) =>
      a.localeCompare(b, "en", { sensitivity: "base" });
    return [...groups]
      .sort(([a], [b]) => byName(a, b))
      .map(([owner, list]) => ({
        owner,
        list: list.sort((a, b) => byName(a.full_name, b.full_name)),
      }));
  }, [repos]);
  const indexPaths = indexPathsFromForm(form.index_paths);
  const collectExcludes = form.collect_excludes
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  // 變更執行設定或索引範圍需要重新驗證，存檔時自動改為未啟用。
  const fields = { ...form, index_paths: indexPaths };
  const configChanged = settingsChanged(p, fields);
  // 新增專案或改了需要重新驗證的設定：主按鈕是「儲存並驗證環境」，另給「只儲存」。
  const offerValidate = offersValidation(p, fields);
  const repoList = repoListStatus(repos, reposError);
  const choose = (full: string) => {
    // 清單載入前後元件可能送出空值，不能因此清掉已選的儲存庫。
    if (!full) return;
    const r = repos?.find((x) => x.full_name === full);
    setForm((f) => ({
      ...f,
      repo: full,
      name: f.name || full.split("/")[1],
      base_branch: r?.default_branch ?? f.base_branch,
      description: f.description || r?.description || "",
    }));
  };
  return (
    <form
      className="flex flex-col gap-4 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (indexPaths.length > 50 || !indexPaths.every(validIndexPath)) {
          setScopeError(
            "請填寫最多 50 個相對檔案或目錄路徑，不能包含 ..、絕對路徑、反斜線或萬用字元。",
          );
          return;
        }
        setScopeError("");
        if (
          collectExcludes.length > MAX_COLLECT_EXCLUDES ||
          !collectExcludes.every(validCollectExclude)
        ) {
          setExcludeError(
            `請填寫最多 ${MAX_COLLECT_EXCLUDES} 條規則：儲存庫內的相對路徑或檔名，可用 * 與結尾 /，開頭 ! 表示移除預設；不能包含 ..、絕對路徑或反斜線。`,
          );
          return;
        }
        setExcludeError("");
        // 在輸入框按 Enter 送出時，瀏覽器以第一顆送出按鈕（主按鈕）為 submitter。
        const submitter = (e.nativeEvent as SubmitEvent)
          .submitter as HTMLButtonElement | null;
        save(
          {
            ...form,
            sensitive_paths: form.sensitive_paths
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean),
            index_paths: indexPaths,
            collect_excludes: collectExcludes,
            enabled: form.enabled && !configChanged && !!p.validated_at,
          },
          offerValidate && submitter?.value !== "save-only",
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="pf-repository">GitHub 儲存庫</Label>
          {pickRepo && repos && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setReposReload((v) => v + 1)}
            >
              <RefreshCw /> 重新整理清單
            </Button>
          )}
        </div>
        {!pickRepo ? (
          <Input id="pf-repository" value={form.repo} readOnly />
        ) : (
          <Select value={form.repo} onValueChange={choose} disabled={!repos}>
            <SelectTrigger id="pf-repository" className="w-full">
              {/* 清單內只列儲存庫名稱，選定後這裡仍顯示含擁有者的完整名稱。 */}
              <SelectValue placeholder={repoList.placeholder}>
                {form.repo}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {p.repo && !repos?.some((r) => r.full_name === p.repo) && (
                <>
                  <SelectItem value={p.repo}>{p.repo}（找不到）</SelectItem>
                  {owners.length > 0 && <SelectSeparator />}
                </>
              )}
              {owners.map(({ owner, list }, i) => (
                <Fragment key={owner}>
                  {i > 0 && <SelectSeparator />}
                  <SelectGroup>
                    <SelectLabel className="sticky -top-1 z-10 flex items-baseline justify-between gap-3 bg-popover font-medium text-foreground">
                      <span className="truncate">{owner}</span>
                      <span className="shrink-0 font-normal text-muted-foreground">
                        {list.length} 個
                      </span>
                    </SelectLabel>
                    {list.map((r) => {
                      const added = taken.has(r.full_name.toLowerCase());
                      return (
                        <SelectItem
                          key={r.full_name}
                          value={r.full_name}
                          className="pl-4"
                          disabled={added}
                        >
                          {r.full_name.slice(owner.length + 1)}
                          {added && "（已加入）"}
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                </Fragment>
              ))}
            </SelectContent>
          </Select>
        )}
        {pickRepo && repoList.error && (
          <div
            role="alert"
            className="space-y-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            <p className="break-words">{repoList.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setReposReload((v) => v + 1)}
            >
              重新取得
            </Button>
          </div>
        )}
        {pickRepo && repoList.empty && (
          <p className="text-xs text-muted-foreground" role="status">
            沒有可選的儲存庫。請先在 GitHub 把 App
            安裝到儲存庫，裝好後按「重新整理清單」。
          </p>
        )}
        {p.id && pickRepo && (
          <p className="text-xs text-muted-foreground">
            {form.repo === p.repo
              ? "GitHub 上找不到這個儲存庫了。搬家或改名的話，在這裡選新的位置；清單只列出已安裝 GitHub App 的儲存庫。"
              : "儲存後會把原本的群組綁定和還沒做的任務掛回來；環境要重新驗證通過才能再啟用。"}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pf-name">顯示名稱</Label>
        <Input
          id="pf-name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pf-desc">說明</Label>
        <Textarea
          id="pf-desc"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="例：MES 前端頁面，包含報工、工單、登入畫面"
        />
        <p className="text-xs text-muted-foreground">
          AI 依這段文字判斷需求屬於哪個專案。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="pf-branch">基底分支</Label>
          <BaseBranchField
            repo={form.repo}
            value={form.base_branch}
            onChange={(name) => set("base_branch", name)}
            request={request}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="pf-image">工作容器映像</Label>
          <Input
            id="pf-image"
            value={form.image}
            onChange={(e) => set("image", e.target.value)}
            required
          />
        </div>
      </div>
      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        <p className="font-medium">
          {form.setup_mode === "auto"
            ? "AI 自動設定安裝與測試"
            : "使用手動指定的安裝與測試"}
        </p>
        <p className="mt-1 text-muted-foreground">
          {form.setup_mode === "auto"
            ? offerValidate
              ? "你按「儲存並驗證環境」後，AI 會依分支內容安裝與測試，通過後啟用派工。"
              : "你儲存後，AI 會在驗證時依分支內容決定如何安裝與測試。"
            : "你儲存的安裝與測試指令會用於環境驗證與派工。"}
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">說明</summary>
          <div className="mt-1">
            {form.setup_mode === "auto"
              ? offerValidate
                ? "不必填指令。按「儲存並驗證環境」，AI 會讀取所選分支的 CI、文件與套件設定，安裝並驗證；成功後自動啟用派工，只有建置或缺少必要資訊時會明確說明。按「只儲存」不會開始驗證，存檔後會打開專案詳情，之後可在那裡驗證。"
                : "不必填指令。AI 依所選分支的 CI、文件與套件設定安裝並驗證；只改名稱或說明不需要重新驗證。"
              : offerValidate
                ? "驗證環境與每次派工都會執行進階設定中的指令。按「儲存並驗證環境」會接著用這些指令驗證；也可以切換成 AI 自動設定。"
                : "驗證環境與每次派工都會執行進階設定中的指令。既有設定已保留，也可以切換成 AI 自動設定。"}
          </div>
        </details>
      </div>
      <details
        className="rounded-md border p-3"
        open={form.setup_mode === "manual" ? true : undefined}
      >
        <summary className="cursor-pointer text-sm font-medium">
          進階設定：手動安裝與測試指令
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-setup-mode">安裝與測試方式</Label>
            <select
              id="pf-setup-mode"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={form.setup_mode}
              onChange={(e) => set("setup_mode", e.target.value)}
            >
              <option value="auto">AI 自動設定（建議）</option>
              <option value="manual">手動指定指令</option>
            </select>
          </div>
          {form.setup_mode === "auto" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="pf-sql-server">測試用 SQL Server</Label>
              <select
                id="pf-sql-server"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={form.sql_server}
                onChange={(e) => set("sql_server", e.target.value)}
              >
                <option value="auto">自動判斷（建議）</option>
                <option value="always">一律提供</option>
                <option value="never">不提供</option>
              </select>
              <p className="text-xs text-muted-foreground">
                自動判斷：專案檔或 CI 顯示測試需要 SQL Server 時，改用含 SQL
                Server
                的映像（line-agentflow-worker-mssql:local），測試階段在容器內啟動資料庫並把
                LocalDB 連線暫時導向它。工作容器映像填自訂映像時不自動更換。
              </p>
            </div>
          )}
          {form.setup_mode === "manual" && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pf-install">
                  安裝命令{" "}
                  <span className="font-normal text-muted-foreground">
                    選填
                  </span>
                </Label>
                <Input
                  id="pf-install"
                  value={form.install_command}
                  onChange={(e) => set("install_command", e.target.value)}
                  placeholder="例：npm ci、pip install -r requirements.txt；不需要就留空"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pf-test">
                  測試命令{" "}
                  <span className="font-normal text-muted-foreground">
                    必填
                  </span>
                </Label>
                <Input
                  id="pf-test"
                  value={form.test_command}
                  onChange={(e) => set("test_command", e.target.value)}
                  placeholder="例：npm test、dotnet test、python -m pytest"
                />
                <p className="text-xs text-muted-foreground">
                  使用專案實際的測試或建置命令。留空無法通過驗證；手動選擇略過測試不代表測試通過。
                </p>
              </div>
            </>
          )}
        </div>
      </details>
      <details
        className="rounded-md border p-3"
        open={collectExcludes.length ? true : undefined}
      >
        <summary className="cursor-pointer text-sm font-medium">
          進階設定：收集時排除的建置產物
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            你加入規則後，符合規則且尚未追蹤的建置產物會從 PR 排除。
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">說明</summary>
            <div className="mt-1">
              收集 AI
              的修改時，版本控制原本沒有追蹤的新檔案若符合下列規則就不放進
              PR，並在 PR
              說明與任務紀錄列出。原本就追蹤的檔案、以及基底已有追蹤檔案的目錄照常收集。預設：
              {DEFAULT_COLLECT_EXCLUDES.map((rule) => (
                <code key={rule} className="mx-0.5 rounded bg-muted px-1">
                  {rule}
                </code>
              ))}
            </div>
          </details>
          <Label htmlFor="pf-collect-excludes">
            增減規則{" "}
            <span className="font-normal text-muted-foreground">
              每行一條；「名稱/」任何層的目錄、「a/b/」從根目錄起、「*.ext」檔名，開頭
              ! 移除預設
            </span>
          </Label>
          <Textarea
            id="pf-collect-excludes"
            value={form.collect_excludes}
            onChange={(e) => {
              set("collect_excludes", e.target.value);
              setExcludeError("");
            }}
            aria-invalid={!!excludeError}
            aria-describedby={excludeError ? "pf-exclude-error" : undefined}
            placeholder={"out/\n!dist/"}
          />
          {excludeError && (
            <p
              id="pf-exclude-error"
              role="alert"
              className="text-sm text-danger"
            >
              {excludeError}
            </p>
          )}
          {collectExcludes.length > 0 &&
            collectExcludes.every(validCollectExclude) && (
              <p className="text-xs text-muted-foreground">
                實際排除：
                {effectiveCollectExcludes(collectExcludes).join("、") ||
                  "（不排除任何檔案）"}
              </p>
            )}
        </div>
      </details>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pf-sensitive">
          額外敏感路徑{" "}
          <span className="font-normal text-muted-foreground">
            每行一項，修改時需人工審核
          </span>
        </Label>
        <Textarea
          id="pf-sensitive"
          value={form.sensitive_paths}
          onChange={(e) => set("sensitive_paths", e.target.value)}
          placeholder="src/auth/"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pf-index-paths">
          索引路徑範圍{" "}
          <span className="font-normal text-muted-foreground">
            每行一個檔案或目錄，留空為全儲存庫
          </span>
        </Label>
        <Textarea
          id="pf-index-paths"
          value={form.index_paths}
          onChange={(e) => {
            set("index_paths", e.target.value);
            setScopeError("");
          }}
          aria-invalid={!!scopeError}
          aria-describedby={scopeError ? "pf-index-error" : undefined}
          placeholder={"README.md\nsrc/views"}
        />
        {scopeError && (
          <p id="pf-index-error" role="alert" className="text-sm text-danger">
            {scopeError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          只檢索所選範圍的可索引文字，敏感檔案與產物仍會排除。請使用儲存庫內的相對路徑，不支援萬用字元。這項設定不限制
          Codex 的專案存取權；變更後需重新驗證環境。
        </p>
      </div>
      <Label className="font-normal">
        <Checkbox
          checked={form.enabled && !configChanged}
          disabled={!p.validated_at || configChanged}
          onCheckedChange={(v) => set("enabled", v === true)}
        />
        啟用自動派工
        {!p.validated_at && (
          <span className="text-muted-foreground">
            （驗證環境通過後自動啟用）
          </span>
        )}
        {configChanged && (
          <span className="text-warn">（已變更設定，存檔後需重新驗證）</span>
        )}
      </Label>
      {offerValidate ? (
        // 主按鈕放第一顆：在輸入框按 Enter 時送出的也是它。手機上兩顆各佔一整行。
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="submit"
            name="intent"
            value="validate"
            className="sm:flex-1"
            disabled={busy}
          >
            <RefreshCw /> 儲存並驗證環境
          </Button>
          <Button
            type="submit"
            name="intent"
            value="save-only"
            variant="outline"
            className="sm:flex-1"
            disabled={busy}
          >
            只儲存
          </Button>
        </div>
      ) : (
        <Button type="submit" disabled={busy}>
          儲存專案
        </Button>
      )}
    </form>
  );
}
