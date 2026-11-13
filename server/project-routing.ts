import { z } from "zod";
import type { DbClient } from "./db.js";
import { notifyGroup } from "./group-replies.js";
import { AppError } from "./policy.js";
import type {
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";
import type {
  ProjectRouting,
  RoutingSource,
} from "../shared/project-routing.js";

export const Routing = z
  .object({
    status: z.enum(["clear", "uncertain", "conflict"]),
    basis: z.enum(["explicit", "repository", "none"]),
    reason: z.string().min(1).max(1000),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["message", "repo"]),
            sourceId: z.string().max(1000),
            quote: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export function mentions(text: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "iu").test(
    text,
  );
}
type Named = Pick<Project, "id" | "name" | "repo">;
/**
 * 專案可被指名的寫法：完整儲存庫、專案名稱，以及在已登記專案中唯一的
 * 儲存庫名稱（斜線後半段）與去掉結尾括號的專案名稱，例如「OrderService」。
 */
export function projectAliases(project: Named, known: Named[]) {
  const short = (p: Named) => [
    p.repo.split("/").pop() ?? "",
    p.name.replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim(),
  ];
  const others = known
    .filter((p) => p.id !== project.id)
    .flatMap((p) => [p.repo, p.name, ...short(p)])
    .map((v) => v.toLowerCase());
  const unique = short(project).filter(
    // 太短的簡稱（例如 API）容易和一般用語混淆，不當成指名。
    (v) => v.length >= 6 && !others.includes(v.toLowerCase()),
  );
  return [...new Set([project.repo, project.name, ...unique])];
}
/** 本批新訊息中被明確指名的已登記專案，依第一次出現的順序。 */
export function namedProjects<P extends Named>(
  texts: string[],
  known: P[],
): P[] {
  const text = texts.join("\n");
  const position = (p: P) =>
    Math.min(
      ...projectAliases(p, known).map((alias) => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = new RegExp(
          `(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`,
          "iu",
        ).exec(text);
        return m ? m.index : Infinity;
      }),
    );
  return known
    .map((p) => ({ p, at: position(p) }))
    .filter((x) => x.at !== Infinity)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.p);
}
export function assessRouting(
  decision: TriageDecision,
  projects: Project[],
  messages: Message[],
  bindingVersion: number,
  sources: RoutingSource[] = [],
  knownProjects: Pick<Project, "id" | "name" | "repo">[] = projects,
): ProjectRouting {
  const uncertain = (reason: string, conflict = false): ProjectRouting => ({
    status: conflict ? "conflict" : "uncertain",
    basis: "none",
    reason,
    evidence: [],
    bindingVersion,
  });
  const project = projects.find((p) => p.id === decision.projectId);
  if (!project)
    return uncertain(
      decision.projectId
        ? "建議專案不在目前可用範圍，請確認群組綁定"
        : "尚未確定目標專案",
      !!decision.projectId,
    );
  const parsed = Routing.safeParse(decision.routing);
  if (!parsed.success) return uncertain("缺少有效的專案選擇理由與證據");
  const route = parsed.data;
  if (route.status !== "clear")
    return { ...route, evidence: [], bindingVersion };
  const roots = messages.filter(
    (m) => !m.contextOnly && decision.sourceIds.includes(m.id),
  );
  const names = (p: Named) => projectAliases(p, knownProjects);
  const contains = (text: string, p: Named) =>
    names(p).some((alias) => mentions(text, alias));
  const named = namedProjects(
    roots.map((m) => m.text ?? ""),
    knownProjects,
  );
  // 查詢可一次讀多個專案：每個被指名的專案都必須已綁定本群組，主要專案也在其中。
  if (
    named.length > 1 &&
    decision.taskType === "query" &&
    route.basis === "explicit" &&
    named.some((p) => p.id === project.id) &&
    named.every((p) => projects.some((b) => b.id === p.id))
  ) {
    const valid =
      route.evidence.length > 0 &&
      route.evidence.every(
        (e) =>
          e.kind === "message" &&
          roots.some((m) => m.id === e.sourceId && m.text?.includes(e.quote)) &&
          named.some((p) => contains(e.quote, p)),
      ) &&
      route.evidence.some((e) => contains(e.quote, project));
    if (valid)
      return {
        ...route,
        bindingVersion,
        relatedProjects: named
          .filter((p) => p.id !== project.id)
          .map(({ id, name, repo }) => ({ id, name, repo })),
      };
  }
  if (named.length > 1 || (named.length === 1 && named[0].id !== project.id))
    return uncertain("需求提及的專案與建議不一致，或同時涉及多個專案", true);
  const foreignRepos = roots
    .flatMap(
      (m) => (m.text ?? "").match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? [],
    )
    .filter(
      (name) =>
        !projects.some((p) => p.repo.toLowerCase() === name.toLowerCase()),
    );
  if (route.basis === "explicit") {
    const valid =
      route.evidence.length > 0 &&
      route.evidence.every(
        (e) =>
          e.kind === "message" &&
          roots.some((m) => m.id === e.sourceId && m.text?.includes(e.quote)) &&
          contains(e.quote, project),
      );
    if (valid && named.length === 1) return { ...route, bindingVersion };
  }
  if (route.basis === "repository") {
    const valid =
      route.evidence.length > 0 &&
      route.evidence.every(
        (e) =>
          e.kind === "repo" &&
          e.quote.trim().length >= 12 &&
          sources.some(
            (s) =>
              s.id === e.sourceId &&
              s.projectId === project.id &&
              s.text.includes(e.quote),
          ) &&
          !sources.some(
            (s) => s.projectId !== project.id && s.text.includes(e.quote),
          ),
      );
    // 檔案路徑可能含斜線，不把它一律當成未綁定的儲存庫；衝突仍由模型明確回報。
    if (valid) return { ...route, bindingVersion };
  }
  return uncertain(
    foreignRepos.length && route.basis === "explicit"
      ? "指定的儲存庫不在可用範圍，請檢查綁定"
      : "引用未能證明這次需求對應到唯一專案，請人工確認",
  );
}

export async function saveProjectConfirmation(
  c: DbClient,
  task: Task,
  kind: "manual" | "evidence",
  actor: string,
) {
  const inserted = await c.query(
    `INSERT INTO task_project_confirmations(task_id,version,project_id,config_version,binding_version,mode,kind,actor,target_branch)
     SELECT t.id,t.version,p.id,p.config_version,g.binding_version,t.mode,$2,$3,t.target_branch
     FROM tasks t JOIN projects p ON p.id=t.project_id JOIN groups g ON g.id=t.group_id
     JOIN group_projects gp ON gp.group_id=g.id AND gp.project_id=p.id
     WHERE t.id=$1 AND t.version=$4 AND t.target_branch IS NOT NULL
     ON CONFLICT(task_id,version) DO UPDATE SET project_id=EXCLUDED.project_id,config_version=EXCLUDED.config_version,
     binding_version=EXCLUDED.binding_version,mode=EXCLUDED.mode,kind=EXCLUDED.kind,actor=EXCLUDED.actor,target_branch=EXCLUDED.target_branch,confirmed_at=now()
     RETURNING task_id`,
    [task.id, kind, actor, task.version],
  );
  if (!inserted.rowCount)
    throw new AppError(409, "專案或綁定已變更，請重新確認");
}

export async function requireProjectConfirmation(c: DbClient, taskId: string) {
  const valid = (
    await c.query("SELECT task_project_confirmed($1) AS valid", [taskId])
  ).rows[0]?.valid;
  if (!valid)
    throw new AppError(409, "目標專案尚未確認或確認已失效，請到看板重新確認");
}

export async function approvalNotice(c: DbClient, task: Task) {
  const p = task.project_id
    ? (
        await c.query("SELECT name,repo FROM projects WHERE id=$1", [
          task.project_id,
        ])
      ).rows[0]
    : null;
  const reason = task.project_routing?.reason ?? "請確認本次需求與目標專案";
  await c.query(
    "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,'approval',$2,$3) ON CONFLICT DO NOTHING",
    [
      task.id,
      `approval:${task.id}:${task.version}`,
      `待確認${task.mode === "query" ? "查詢" : "修改"}：${task.title}\n目標專案：${p ? `${p.name}（${p.repo}）` : "尚未指定"}\n目標分支：${task.target_branch ?? "待選擇"}\n${reason}\n${task.branch_selection?.reason ?? "請核對目標分支"}\n請到看板檢視需求、專案與分支後確認。`,
    ],
  );
  await notifyGroup(
    c,
    task.id,
    "received",
    `received:${task.id}`,
    `收到${task.mode === "query" ? "查詢" : "需求"}「${task.title}」，等管理者確認後開始處理。`,
    "all",
  );
}
