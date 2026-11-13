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
import { type Request, type Run, type State, Empty, date } from "./shared";
import { ConfirmButton } from "./confirm";
import { useUnsaved, useGuard } from "./unsaved";
import { ProjectContextEditor } from "./project-context";
import { ProjectDatabase } from "./project-database";
import { verificationLabel } from "../../shared/project-setup.js";
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
}: {
  state: State;
  busy: boolean;
  run: Run;
  request: Request;
  edit: (p: Partial<Project>) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const guard = useGuard();
  const open = state.projects.find((p) => p.id === openId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          共 {state.projects.length} 個專案，
          {
            state.projects.filter(
              (p) =>
                p.enabled &&
                p.validated_at &&
                state.groups.some((g) => g.project_ids.includes(p.id)),
            ).length
          }{" "}
          個可派工
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
                      )}
                    >
                      {p.setup_mode === "auto" ? (
                        p.setup_status || "AI 自動設定"
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
                    <p className="text-warn">
                      {verificationLabel(open.setup_plan).caution}
                    </p>
                  )}
                  <p>{open.setup_plan.explanation}</p>
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
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs break-all text-danger">
                  {open.validation_error}
                </p>
              )}
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
                <RefreshCw />{" "}
                {open.repo_missing_at
                  ? "重新檢查"
                  : open.setup_mode === "auto"
                    ? "AI 自動設定並驗證"
                    : "驗證環境"}
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

// 可派工還要有群組使用；沒有群組綁定的專案收不到任何需求。
function ProjectBadge({
  project: p,
  bound,
}: {
  project: Project;
  bound: boolean;
}) {
  const ready = p.enabled && p.validated_at;
  if (p.setup_input) return <Badge variant="warn">等你回答</Badge>;
  if (p.repo_missing_at)
    return (
      <Badge
        variant="danger"
        title="GitHub 上找不到這個儲存庫（可能已刪除、搬家或改名），專案先停用並暫時解除群組綁定"
      >
        找不到儲存庫
      </Badge>
    );
  if (ready && !bound)
    return (
      <Badge variant="secondary" title="到群組管理勾選這個專案後才會收到需求">
        未綁定群組
      </Badge>
    );
  return (
    <Badge variant={ready ? "good" : p.validated_at ? "info" : "warn"}>
      {ready ? "可派工" : p.validated_at ? "已驗證・未啟用" : "需要驗證"}
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
  save: (p: unknown) => unknown;
  request: Request;
}) {
  const [repos, setRepos] = useState<
    { full_name: string; default_branch: string; description: string }[] | null
  >(null);
  const [scopeError, setScopeError] = useState("");
  const [excludeError, setExcludeError] = useState("");
  const [form, setForm] = useState({
    repo: p.repo ?? "",
    name: p.name ?? "",
    description: p.description ?? "",
    base_branch: p.base_branch ?? "main",
    image: p.image ?? "line-agentflow-worker:local",
    setup_mode: p.setup_mode ?? (p.id ? "manual" : "auto"),
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
    if (pickRepo)
      void request<NonNullable<typeof repos>>("/api/repositories")
        .then(setRepos)
        .catch(() => setRepos([]));
  }, [pickRepo, request]);
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
  const configChanged =
    !!p.id &&
    (form.repo !== p.repo ||
      form.base_branch !== p.base_branch ||
      form.image !== p.image ||
      form.setup_mode !== (p.setup_mode ?? "manual") ||
      form.install_command !== p.install_command ||
      form.test_command !== p.test_command ||
      form.sensitive_paths !== (p.sensitive_paths?.join("\n") ?? "") ||
      JSON.stringify(indexPaths) !== JSON.stringify(p.index_paths ?? []));
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
        save({
          ...form,
          sensitive_paths: form.sensitive_paths
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          index_paths: indexPaths,
          collect_excludes: collectExcludes,
          enabled: form.enabled && !configChanged && !!p.validated_at,
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <Label>GitHub 儲存庫</Label>
        {!pickRepo ? (
          <Input value={form.repo} readOnly />
        ) : (
          <Select value={form.repo} onValueChange={choose} disabled={!repos}>
            <SelectTrigger className="w-full">
              {/* 清單內只列儲存庫名稱，選定後這裡仍顯示含擁有者的完整名稱。 */}
              <SelectValue
                placeholder={
                  repos ? "選擇已安裝 GitHub App 的儲存庫" : "載入中…"
                }
              >
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
                    {list.map((r) => (
                      <SelectItem
                        key={r.full_name}
                        value={r.full_name}
                        className="pl-4"
                      >
                        {r.full_name.slice(owner.length + 1)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </Fragment>
              ))}
              {repos?.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  沒有可選的儲存庫。請先在 GitHub 把 App 安裝到儲存庫。
                </p>
              )}
            </SelectContent>
          </Select>
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
            ? "不必填指令。儲存後按「AI 自動設定並驗證」，AI 會讀取所選分支的 CI、文件與套件設定，安裝並驗證。成功後自動啟用派工；只有建置或缺少必要資訊時會明確說明。"
            : "驗證環境與每次派工都會執行進階設定中的指令。既有設定已保留，也可以切換成 AI 自動設定。"}
        </p>
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
            收集 AI 的修改時，版本控制原本沒有追蹤的新檔案若符合下列規則就不放進
            PR，並在 PR
            說明與任務紀錄列出。原本就追蹤的檔案、以及基底已有追蹤檔案的目錄照常收集。預設：
            {DEFAULT_COLLECT_EXCLUDES.map((rule) => (
              <code key={rule} className="mx-0.5 rounded bg-muted px-1">
                {rule}
              </code>
            ))}
          </p>
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
      <Button disabled={busy}>儲存專案</Button>
    </form>
  );
}
