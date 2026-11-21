import { dashboardAlerts } from "./dashboard-alerts.js";
import { pickLists, registerPickLists } from "./pick-lists.js";
import { createFollowup, relinkTask } from "./followup.js";
import { probeSystem } from "./system-status.js";
import { answerFromDashboard } from "./answers.js";
import { frictionMetrics } from "./friction.js";
import {
  approveCheck,
  checkDetail,
  clearCheckEnvironment,
  createCheck,
  deleteCheck,
  listChecks,
  setCheckPaused,
  syncCheckEnvironments,
  testCheck,
  updateCheck,
} from "./checks.js";
import {
  checkEnvironmentLimits,
  checkEnvironmentPolicy,
  defaultCheckEnvironmentPolicy,
} from "../shared/check-environment.js";
import { requestBackfill } from "./retrieval.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { HttpEmbedder, type Embedder } from "./embedder.js";
import { validIndexPath } from "../shared/repo-scope.js";
import { Database } from "./db.js";
import { config, secrets, secretsPath, token } from "./config.js";
import { currentEntry } from "./tunnel-provider.js";
import { registerAuth, requireAdmin, requireUser, hash } from "./auth.js";
import { registerMembers } from "./members.js";
import { registerCapacity } from "./capacity-api.js";
import { checkIntegrations } from "./integrations.js";
import { registerChat } from "./chat.js";
import { registerProjectContext } from "./project-context.js";
import { registerProjectDatabase } from "./project-database.js";
import { registerProjectSsh } from "./project-ssh.js";
import { diskPaused, registerDockerDisk } from "./docker-disk.js";
import { registerEgress } from "./egress-api.js";
import { notifyGroup } from "./group-replies.js";
import { HttpRunner, type Runner } from "./execution.js";
import { clientAddress } from "./client-address.js";
import { replyError } from "./error-reply.js";
import { AppError, verifySignature } from "./policy.js";
import { Line } from "./line.js";
import {
  expireStaleNotifications,
  lineQuotaBlocked,
  staleNotification,
} from "./line-quota.js";
import {
  LINE_QUOTA,
  quotaBellNotice,
  quotaRetryBlocked,
} from "../shared/line-quota.js";
import { BatchEnd, Tasks } from "./tasks.js";
import { Budget } from "./budget.js";
import { ProjectSetup } from "./project-setup.js";
import {
  lockSubscriptionGate,
  SubscriptionGate,
  subscriptionGateName,
} from "./subscription-gate.js";
import { maxCodexReserve } from "../shared/subscription-quota.js";
import { linePrivateModes } from "../shared/line-private.js";
import { GitHub } from "./github.js";
import { TargetBranch } from "./task-branch.js";
import { registerProxy } from "./proxy.js";
import {
  markRepoMissing,
  repoFound,
  repointRepo,
  syncProjectRepos,
  type RepoLocation,
} from "./repo-missing.js";
import type {
  Action,
  NotificationFailures,
  NotificationRetryResult,
  Project,
  Settings,
  StateTotals,
  Task,
  TaskPage,
  TaskStatus,
} from "../shared/types.js";
import { describeChanges, settingsDiff } from "../shared/settings-diff.js";
import { containsCredential } from "../shared/credentials.js";
import {
  taskEndColumns,
  taskEndJoins,
  withTaskEnd,
  type TaskWithEndAudit,
} from "./task-end.js";
import {
  countStatuses,
  efforts,
  endedStatuses,
  UNFINISHED_LIMIT,
  unfinishedStatuses,
} from "../shared/types.js";
import {
  MAX_COLLECT_EXCLUDES,
  validCollectExclude,
} from "../shared/build-output.js";
declare module "fastify" {
  interface FastifyRequest {
    rawBody: Buffer;
  }
}
// 「擁有者/名稱」；單獨的 . 或 .. 會讓 GitHub API 路徑跳層，不算名稱。
const RepoName = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .refine((repo) => repo.split("/").every((part) => !/^\.+$/.test(part)));
const ProjectInput = z.object({
  name: z.string().min(1).max(100),
  repo: RepoName,
  description: z.string().max(2000).default(""),
  // 與任務的目標分支同一套規則：表單的分支清單列得出來的名稱都要存得進去。
  base_branch: TargetBranch,
  image: z.string().min(1).max(200),
  setup_mode: z.enum(["auto", "manual"]).optional(),
  // 測試用 SQL Server：自動判斷，或由管理者一律提供／不提供。省略時保留原設定。
  sql_server: z.enum(["auto", "always", "never"]).optional(),
  install_command: z.string().trim().max(8000).default(""),
  test_command: z.string().trim().max(8000).default(""),
  sensitive_paths: z.array(z.string().min(1)).max(100),
  index_paths: z
    .array(
      z
        .string()
        .trim()
        .transform((value) => value.replace(/\/$/, ""))
        .refine(
          validIndexPath,
          "索引範圍須為儲存庫內相對檔案或目錄，不可使用跳層、反斜線或萬用字元",
        ),
    )
    .max(50)
    .transform((values) => [...new Set(values)].sort())
    .optional(),
  // 對預設建置產物排除清單的增減；省略時保留原設定。
  collect_excludes: z
    .array(
      z
        .string()
        .trim()
        .refine(
          validCollectExclude,
          "排除規則須為儲存庫內相對路徑或檔名，可用 * 與結尾 /，開頭 ! 表示移除預設，不可跳層或使用反斜線",
        ),
    )
    .max(MAX_COLLECT_EXCLUDES)
    .transform((values) => [...new Set(values)])
    .optional(),
  enabled: z.boolean(),
});
/** 唯一允許被同源 iframe 嵌入的頁面（系統頁的架構動畫）。 */
export const EMBEDDABLE_PAGE = "/docs/architecture-flow.html";
/** 把 CSP 的 frame-ancestors 改成只允許同源；其他指令不變。 */
export const allowSameOriginFrame = (csp: string) =>
  csp.replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'");

export async function buildApp(
  db: Database,
  enqueueValidation?: (id: string) => Promise<unknown>,
  embedder: Embedder = new HttpEmbedder(),
  githubUser?: Parameters<typeof registerMembers>[2],
  runner: Pick<Runner, "call"> = new HttpRunner(),
  validationProgress?: import("./validation-queue.js").ValidationQueue["progress"],
) {
  const app = Fastify({
    logger: {
      level: "warn",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 3 * 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  // 檢查、專案（含資料庫連線與綁定）、群組或系統設定一有變更，立即請執行器清掉不再有效的檢查環境（#19）；
  // 排程每分鐘也會再核對一次，這裡失敗不影響原本的操作。必須在註冊任何路由之前加上。
  let checkSync: Promise<unknown> = Promise.resolve();
  app.addHook("onResponse", async (req, reply) => {
    if (
      req.method === "GET" ||
      reply.statusCode >= 400 ||
      !/^\/api\/(checks|projects|groups|settings)(\/|\?|$)/.test(req.url)
    )
      return;
    checkSync = checkSync
      .then(() =>
        syncCheckEnvironments(db, (path, body, timeoutMs) =>
          runner.call(path, body, timeoutMs),
        ),
      )
      .catch(() => {});
  });
  app.addHook("onClose", async () => {
    await checkSync;
  });
  // Fastify 的路由在建立當下就取用當時的錯誤處理器，之後才呼叫 setErrorHandler 不會套到已註冊的路由。
  // 所以這行必須在任何 register*／app.get 之前：輸入格式錯誤才會一律回「輸入格式錯誤」與 details，
  // 不會落到 Fastify 預設的 { error: "Bad Request" }（看板只會顯示英文狀態名稱）。
  app.setErrorHandler(replyError);
  registerChat(app, db);
  registerPickLists(app, db);
  registerProjectContext(app, db, enqueueValidation);
  const askConnection = (prompt: string, schema: Record<string, unknown>) =>
    new ProjectSetup(
      db,
      new GitHub(),
      runner as Runner,
      new Budget(db),
      new SubscriptionGate(db),
    ).structured(prompt, schema, "connection_extract", "整理連線資訊");
  registerProjectDatabase(
    app,
    db,
    (path, body, timeoutMs) => runner.call(path, body, timeoutMs),
    enqueueValidation,
    askConnection,
  );
  registerProjectSsh(
    app,
    db,
    (path, body, timeoutMs) => runner.call(path, body, timeoutMs),
    askConnection,
  );
  registerMembers(app, db, githubUser);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  // 系統頁以同源 iframe 嵌入架構動畫：只有這一頁允許同源嵌入，其餘頁面與 API 維持禁止被嵌入。
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.split("?")[0] === EMBEDDABLE_PAGE) {
      const csp = reply.getHeader("content-security-policy");
      if (typeof csp === "string")
        reply.header("content-security-policy", allowSameOriginFrame(csp));
    }
    return payload;
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute",
    allowList: (req) => req.url.startsWith("/internal/proxy/"),
    // 外部流量都經通道進來，連線來源全是同一個位址；
    // 改用通道回報的用戶端位址計算，看板使用者與 Webhook 才不會共用同一份額度。
    keyGenerator: (req) =>
      clientAddress(req.ip, req.headers["x-forwarded-for"]),
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      try {
        done(null, JSON.parse(body.toString()));
      } catch {
        done(new AppError(400, "JSON 格式錯誤"));
      }
    },
  );
  const line = new Line(db),
    tasks = new Tasks(db),
    budget = new Budget(db),
    github = new GitHub();
  await registerAuth(app, db);
  registerProxy(app, db, budget);
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/public/status", async () => {
    const s = secrets();
    return {
      name: "chat2pr",
      githubConfigured: !!s.githubClientId,
      setupRequired: !s.githubClientId,
    };
  });
  app.post("/webhooks/line", async (req, reply) => {
    if (
      !verifySignature(
        req.rawBody,
        String(req.headers["x-line-signature"] ?? ""),
        secrets().lineSecret ?? "",
        "base64",
      )
    )
      throw new AppError(401, "LINE 簽章錯誤");
    await line.ingest(req.body);
    return reply.code(200).send({ ok: true });
  });
  app.post("/webhooks/github", async (req) => {
    if (
      !verifySignature(
        req.rawBody,
        String(req.headers["x-hub-signature-256"] ?? ""),
        secrets().githubWebhookSecret ?? "",
        "hex",
      )
    )
      throw new AppError(401, "GitHub 簽章錯誤");
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    if (!delivery) throw new AppError(400, "缺少事件識別碼");
    const body = req.body as {
      action?: string;
      repository?: { id?: number; full_name: string };
      repositories?: { id?: number; full_name: string }[];
      repositories_removed?: { id?: number; full_name: string }[];
      changes?: {
        repository?: { name?: { from?: string } };
        owner?: {
          from?: {
            user?: { login?: string };
            organization?: { login?: string };
          };
        };
      };
      pull_request?: { number: number; state: string; merged: boolean };
      check_run?: { conclusion?: string; pull_requests?: { number: number }[] };
    };
    const event = String(req.headers["x-github-event"] ?? "");
    // App 被移出儲存庫或整個解除安裝：儲存庫可能只是轉移到另一個也裝了 App 的帳號或組織，
    // 先問 GitHub 現在在哪（只問有對應專案的），找得到就跟過去，不必停用。
    const removed =
      event === "installation_repositories" && body.action === "removed"
        ? (body.repositories_removed ?? [])
        : event === "installation" && body.action === "deleted"
          ? (body.repositories ?? [])
          : [];
    const elsewhere = new Map<string, { project: string; at: RepoLocation }>();
    for (const r of removed) {
      const p = await db.one<Project>(
        "SELECT * FROM projects WHERE lower(repo)=lower($1) AND repo_missing_at IS NULL",
        [r.full_name],
      );
      if (!p) continue;
      try {
        const at = await github.locateRepo(
          p.repo,
          r.id ?? (p.repo_id ? Number(p.repo_id) : null),
        );
        if (at) elsewhere.set(r.full_name, { project: p.id, at });
      } catch {
        // 查不到就先照失去存取權處理；之後定期檢查找得到會自動接回。
      }
    }
    await db.transaction(async (c) => {
      const insert = await c.query(
        "INSERT INTO events(id,provider) VALUES($1,'github') ON CONFLICT DO NOTHING RETURNING id",
        [`github:${delivery}`],
      );
      if (!insert.rowCount) return;
      // 儲存庫被刪除，或 GitHub App 被移出儲存庫／整個解除安裝：對應的專案立即停用並通知。
      // 其他事件（標籤、分支保護等）也有 action=deleted，所以一定要看事件種類。
      if (
        event === "repository" &&
        body.action === "deleted" &&
        body.repository
      )
        await markRepoMissing(c, body.repository.full_name, "deleted");
      for (const r of removed) {
        const moved = elsewhere.get(r.full_name);
        if (moved) await repoFound(c, moved.project, moved.at);
        else await markRepoMissing(c, r.full_name, "access");
      }
      // 改名或轉移：GitHub 直接告訴我們新位置，專案跟過去就好。
      if (
        event === "repository" &&
        ["renamed", "transferred"].includes(body.action ?? "") &&
        body.repository?.id
      ) {
        const [owner, name] = body.repository.full_name.split("/");
        const from = body.changes?.owner?.from;
        const before = `${from?.user?.login ?? from?.organization?.login ?? owner}/${body.changes?.repository?.name?.from ?? name}`;
        const hit = (
          await c.query(
            "SELECT id FROM projects WHERE repo_id=$1 OR (repo_id IS NULL AND lower(repo)=lower($2)) ORDER BY repo_id NULLS LAST LIMIT 1",
            [body.repository.id, before],
          )
        ).rows[0] as { id: string } | undefined;
        if (hit)
          await repoFound(c, hit.id, {
            id: body.repository.id,
            full_name: body.repository.full_name,
          });
      }
      if (body.pull_request && body.repository) {
        const p = body.pull_request;
        const status = p.merged
          ? "merged"
          : p.state === "closed"
            ? "closed"
            : "ready";
        // 只記錄真的改變狀態的任務，時間軸才看得到 PR 何時合併或關閉。
        const changed = await c.query<{ id: string; title: string }>(
          "UPDATE tasks t SET status=$1,updated_at=now() FROM projects p WHERE t.project_id=p.id AND p.repo=$2 AND t.pr_number=$3 AND t.status IN ('ready','merged','closed') AND t.status<>$1 RETURNING t.id,t.title",
          [status, body.repository.full_name, p.number],
        );
        if (status !== "ready")
          for (const row of changed.rows)
            await notifyGroup(
              c,
              row.id,
              status,
              `${status}:${row.id}:${p.number}`,
              status === "merged"
                ? `「${row.title}」的修改已合併。`
                : `「${row.title}」的 PR 已關閉，這次修改沒有採用。`,
            );
        for (const row of changed.rows)
          await db.audit(
            row.id,
            status,
            status === "ready"
              ? `PR #${p.number} 已在 GitHub 重新開啟`
              : `PR #${p.number} 已在 GitHub ${status === "merged" ? "合併" : "關閉"}`,
            c,
          );
        if (p.state === "closed")
          await c.query(
            "UPDATE project_knowledge k SET status=$1 FROM projects p WHERE k.project_id=p.id AND p.repo=$2 AND k.pr_number=$3 AND k.status='in_pr'",
            [
              p.merged ? "merged" : "closed",
              body.repository.full_name,
              p.number,
            ],
          );
      }
      if (
        body.check_run &&
        ["failure", "timed_out", "cancelled", "action_required"].includes(
          body.check_run.conclusion ?? "",
        )
      )
        for (const pr of body.check_run.pull_requests ?? []) {
          const t = (
            await c.query(
              "SELECT t.id,t.title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.repo=$1 AND t.pr_number=$2",
              [body.repository?.full_name, pr.number],
            )
          ).rows[0];
          if (t) {
            await db.audit(
              t.id,
              "ci_failed",
              "GitHub 檢查未通過，請檢視 PR",
              c,
            );
            await c.query(
              "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,'ci',$2,$3) ON CONFLICT DO NOTHING",
              [
                t.id,
                `ci:${delivery}:${t.id}`,
                `GitHub 檢查需要處理：${t.title}`,
              ],
            );
          }
        }
    });
    // App 剛裝到新的帳號、組織或儲存庫：之前找不到的專案可能就在那裡，馬上再找一次。
    if (
      (event === "installation" && body.action === "created") ||
      (event === "installation_repositories" && body.action === "added")
    )
      await syncProjectRepos(db, github, "missing");
    return { ok: true };
  });
  app.post("/api/rag/backfill", async (req, reply) => {
    await requireAdmin(db, req);
    await requestBackfill(db);
    return reply.code(202).send({ ok: true });
  });
  app.get("/api/state", async (req) => {
    const user = await requireUser(db, req);
    const admin = user.role === "admin";
    // 清單預設只給最近的資料；看板按「載入更多」時才放大。
    const limits = z
      .object({
        tasks: z.coerce.number().int().min(1).max(5000).catch(250),
        activity: z.coerce.number().int().min(1).max(2000).catch(80),
      })
      .parse(req.query ?? {});
    const [
      diskDispatchPaused,
      totals,
      alerts,
      seen,
      settings,
      projects,
      groups,
      tasks,
      usage,
      health,
      activity,
      memories,
      knowledge,
      runsToday,
      rag,
      failures,
      validations,
      pendingLists,
    ] = await Promise.all([
      diskPaused(db),
      // 看板的分頁數字與統計卡用資料庫的實際數量，不受清單載入範圍影響。
      db.one<{
        tasks: number;
        activity: number;
        by_status: Partial<Record<TaskStatus, number>>;
        merged_week: number;
      }>(
        `SELECT (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM audit WHERE $1::boolean OR task_id IS NOT NULL) AS activity,
           coalesce((SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*)::int AS n FROM tasks GROUP BY status) s),'{}') AS by_status,
           (SELECT count(*)::int FROM tasks WHERE status='merged'
             AND (updated_at AT TIME ZONE 'Asia/Taipei')::date>(now() AT TIME ZONE 'Asia/Taipei')::date-7) AS merged_week`,
        [admin],
      ),
      dashboardAlerts(db, admin),
      db.one<{ seen_at: string }>(
        "SELECT seen_at FROM alert_seen WHERE user_id=$1",
        [user.user_id],
      ),
      db.settings(),
      db.query<Project>(
        "SELECT p.*,r.phase AS index_phase,r.chunks AS index_chunks,r.error AS index_error FROM projects p LEFT JOIN repo_indexes r ON r.project_id=p.id ORDER BY p.created_at",
      ),
      db.query(
        "SELECT g.*,COALESCE((SELECT array_agg(gp.project_id ORDER BY gp.created_at) FROM group_projects gp WHERE gp.group_id=g.id),'{}') AS project_ids,(SELECT count(*)::int FROM tasks t WHERE t.group_id=g.id AND t.status IN ('queued','budget_wait','failed','running','reviewing')) AS affected_tasks FROM groups g ORDER BY g.created_at,g.id",
      ),
      // 未結束的任務（待審核、失敗、等待額度、進行中、待合併）一律載入，較舊的也不會從收件匣消失；
      // 其餘只給最近 N 筆。進行中的執行只帶階段與時間四欄，執行細節由任務詳情提供。
      db.query<TaskWithEndAudit>(
        `WITH picked AS (
           (SELECT id FROM tasks WHERE status=ANY($2::text[]) ORDER BY updated_at DESC LIMIT $3)
           UNION
           (SELECT id FROM tasks ORDER BY updated_at DESC LIMIT $1))
         SELECT t.*,r.status AS run_phase,r.started_at AS run_started_at,r.deadline AS run_deadline,r.heartbeat_at AS run_heartbeat_at,
           ${taskEndColumns}
         FROM tasks t JOIN picked p ON p.id=t.id
         LEFT JOIN LATERAL (SELECT status,started_at,deadline,heartbeat_at FROM runs
           WHERE task_id=t.id AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1) r ON true
         ${taskEndJoins}
         ORDER BY t.updated_at DESC,t.id`,
        [limits.tasks, unfinishedStatuses, UNFINISHED_LIMIT],
      ),
      budget.summary(),
      db.query("SELECT * FROM service_health ORDER BY name"),
      // 無任務的管理稽核可能含私訊內容；分頁資料與上方總數必須使用相同條件。
      db.query(
        "SELECT a.*,t.title AS task_title,t.mode AS task_mode FROM audit a LEFT JOIN tasks t ON t.id=a.task_id WHERE $2::boolean OR a.task_id IS NOT NULL ORDER BY a.id DESC LIMIT $1",
        [limits.activity, admin],
      ),
      db.query("SELECT * FROM group_memories ORDER BY created_at"),
      db.query(
        "SELECT * FROM project_knowledge WHERE status<>'closed' ORDER BY created_at",
      ),
      db.one<{ count: number }>(
        "SELECT count(*)::int AS count FROM runs WHERE (started_at AT TIME ZONE 'Asia/Taipei')::date=(now() AT TIME ZONE 'Asia/Taipei')::date",
      ),
      db.one(
        "SELECT active,completed_at,coalesce((SELECT jsonb_object_agg(kind,n) FROM (SELECT kind,count(*)::int n FROM embeddings GROUP BY kind) counts),'{}') AS counts FROM rag_backfill WHERE id",
      ),
      // 送不出去的通知分私訊與群組（群組依人數計入額度）；過時的重送時會略過，另外計數。
      db.one<NotificationFailures>(
        `SELECT count(*) FILTER (WHERE NOT stale AND attempts>=3 AND group_id IS NULL)::int AS direct,
           count(*) FILTER (WHERE NOT stale AND attempts>=3 AND group_id IS NOT NULL)::int AS "group",
           count(*) FILTER (WHERE stale)::int AS stale
         FROM (SELECT n.group_id,n.attempts,${staleNotification} AS stale FROM notifications n
           LEFT JOIN tasks t ON t.id=n.task_id WHERE n.sent_at IS NULL) x`,
      ),
      validationProgress?.() ?? [],
      admin ? pickLists(db) : [],
    ]);
    const progressByProject = new Map(
      validations.map((entry) => [entry.id, entry]),
    );
    const s = secrets();
    // 推播額度用完時，鈴鐺清單頂端放一行提示；鈴鐺讀資料庫，不需要推播。
    const quota = (
      health as { name: string; ok: boolean; checked_at: string }[]
    ).find((h) => h.name === LINE_QUOTA && !h.ok);
    return {
      settings: {
        ...settings,
        admin_line_id: settings.admin_line_id ? "已綁定" : null,
      },
      alerts: quota
        ? [
            {
              id: LINE_QUOTA,
              task_id: null,
              kind: LINE_QUOTA,
              disposition: "resolved",
              text: quotaBellNotice,
              created_at: quota.checked_at,
              title: null,
            },
            ...alerts,
          ]
        : alerts,
      alertsSeenAt: seen?.seen_at ?? null,
      // 清單總筆數與送不出去的 LINE 通知數，讓看板知道還有多少沒顯示、多少要重送。
      totals: {
        tasks: totals?.tasks ?? 0,
        activity: totals?.activity ?? 0,
        byStatus: totals?.by_status ?? {},
        mergedWeek: totals?.merged_week ?? 0,
        unfinishedOmitted: Math.max(
          0,
          countStatuses(totals?.by_status, unfinishedStatuses) -
            UNFINISHED_LIMIT,
        ),
      } satisfies StateTotals,
      failedNotifications: (failures?.direct ?? 0) + (failures?.group ?? 0),
      notificationFailures: failures ?? { direct: 0, group: 0, stale: 0 },
      projects: projects.map((project) => {
        const validation = progressByProject.get(project.id);
        return validation?.version === project.config_version
          ? { ...project, validation_progress: validation.progress }
          : project;
      }),
      groups,
      tasks: tasks.map(withTaskEnd),
      pickLists: pendingLists,
      rag,
      usage: { ...usage, runs_today: runsToday.count },
      diskDispatchPaused,
      health,
      activity,
      memories,
      knowledge,
      integrations: {
        line: !!s.lineSecret && !!s.lineToken,
        openai: !!s.openaiKey,
        github: !!s.githubAppId && !!s.githubPrivateKey,
        publicUrl: config().publicUrl,
      },
      webhooks: {
        line: `${config().publicUrl}/webhooks/line`,
        github: `${config().publicUrl}/webhooks/github`,
      },
    };
  });
  app.get("/api/events", async (req, reply) => {
    await requireUser(db, req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("event: connected\ndata: {}\n\n");
    let last = "";
    const timer = setInterval(() => {
      void Promise.all([
        db.one<{ stamp: string }>(
          "SELECT concat((SELECT max(updated_at)::text FROM tasks),':',(SELECT max(id) FROM audit),':',(SELECT max(checked_at)::text FROM service_health),':',(SELECT max(id) FROM run_events),':',(SELECT max(heartbeat_at)::text FROM runs),':',(SELECT max(completed_at)::text FROM runs),':',(SELECT revision FROM chat_revision WHERE id=1)) AS stamp",
        ),
        validationProgress?.() ?? [],
      ])
        .then(([r, validations]) => {
          const stamp = r.stamp + JSON.stringify(validations);
          if (stamp !== last) {
            last = stamp;
            reply.raw.write("event: update\ndata: {}\n\n");
          } else reply.raw.write(": heartbeat\n\n");
        })
        .catch(() => reply.raw.end());
    }, 5000);
    reply.raw.on("close", () => clearInterval(timer));
  });
  // 使用摩擦指標：每件任務需要人回應幾次、要切到看板幾次、等多久。
  app.get("/api/metrics/friction", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        group_id: z.string().max(100).optional(),
      })
      .parse(req.query);
    return frictionMetrics(db, q.days, q.group_id || null);
  });
  // 定期檢查：成員可以看；建立、修改、試跑、核准、暫停與刪除需要管理者。
  const checkId = (req: { params: unknown }) =>
    z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
  const runnerCall = <T>(path: string, body: unknown, timeoutMs?: number) =>
    runner.call<T>(path, body, timeoutMs);
  app.get("/api/checks", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    return listChecks(db, runnerCall);
  });
  app.get("/api/check-environments/settings", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    return {
      ...checkEnvironmentPolicy(await db.settings()),
      defaults: defaultCheckEnvironmentPolicy,
      limits: checkEnvironmentLimits,
    };
  });
  // 放在 /api/settings 之下，存檔後由 onResponse 立即套用到執行器。
  app.put("/api/settings/check-environments", async (req) => {
    await requireAdmin(db, req);
    const l = checkEnvironmentLimits;
    const b = z
      .object({
        idleMinutes: z
          .number()
          .int()
          .min(l.idleMinutes.min)
          .max(l.idleMinutes.max),
        max: z.number().int().min(l.max.min).max(l.max.max),
      })
      .parse(req.body);
    await db.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
      JSON.stringify({
        check_env_idle_minutes: b.idleMinutes,
        check_env_max: b.max,
      }),
    ]);
    await db.audit(
      null,
      "settings",
      `定期檢查環境改為閒置 ${b.idleMinutes} 分鐘清除、最多保留 ${b.max} 個`,
    );
    return { ok: true };
  });
  app.post("/api/checks/:id/environment/clear", async (req) => {
    const actor = await requireAdmin(db, req);
    return clearCheckEnvironment(db, runnerCall, checkId(req), actor.login);
  });
  app.get("/api/checks/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    return checkDetail(db, checkId(req));
  });
  app.post("/api/checks", async (req) => {
    const actor = await requireAdmin(db, req);
    return createCheck(db, req.body, actor.login);
  });
  app.put("/api/checks/:id", async (req) => {
    const actor = await requireAdmin(db, req);
    const { version, ...input } = z
      .object({ version: z.number().int().positive() })
      .passthrough()
      .parse(req.body);
    return updateCheck(db, checkId(req), version, input, actor.login);
  });
  app.post("/api/checks/:id/test", async (req) => {
    await requireAdmin(db, req);
    return testCheck(db, runnerCall, checkId(req));
  });
  app.post("/api/checks/:id/approve", async (req) => {
    const actor = await requireAdmin(db, req);
    const { version } = z
      .object({ version: z.number().int().positive() })
      .parse(req.body);
    return approveCheck(db, checkId(req), version, actor.login);
  });
  app.post("/api/checks/:id/pause", async (req) => {
    const actor = await requireAdmin(db, req);
    return setCheckPaused(db, checkId(req), true, actor.login);
  });
  app.post("/api/checks/:id/resume", async (req) => {
    const actor = await requireAdmin(db, req);
    return setCheckPaused(db, checkId(req), false, actor.login);
  });
  app.delete("/api/checks/:id", async (req) => {
    const actor = await requireAdmin(db, req);
    return deleteCheck(db, checkId(req), actor.login);
  });
  app.get("/api/tasks", async (req, reply): Promise<TaskPage> => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    const query = z
      .object({
        filter: z.enum(["all", "closed"], {
          error: "請選擇全部或已結束的任務",
        }),
        group: z.string().optional(),
        project: z
          .union([z.literal("none"), z.uuid()], { error: "請選擇有效的專案" })
          .optional(),
        q: z.string().optional(),
        before: z.iso
          .datetime({ error: "任務清單的更新時間格式不正確" })
          .optional(),
        beforeId: z.uuid({ error: "任務清單的編號格式不正確" }).optional(),
      })
      .refine(({ before, beforeId }) => !!before === !!beforeId, {
        message: "載入下一批任務時需要提供更新時間和任務編號",
      })
      .parse(req.query);
    const pageSize = 30;
    const rows = await db.query<TaskWithEndAudit & { cursor_time: string }>(
      `WITH picked AS (
         SELECT t.* FROM tasks t
         WHERE ($1::text[] IS NULL OR t.status=ANY($1))
           AND ($2::text IS NULL OR t.group_id=$2)
           AND ($3::text IS NULL OR coalesce(t.project_id::text,'none')=$3)
           AND ($4::text IS NULL OR strpos(lower(t.title||' '||t.summary),lower($4))>0)
           AND ($5::timestamptz IS NULL OR (t.updated_at,t.id)<($5,$6::uuid))
         ORDER BY t.updated_at DESC,t.id DESC LIMIT $7
       )
       SELECT t.*,r.status AS run_phase,r.started_at AS run_started_at,r.deadline AS run_deadline,
         r.heartbeat_at AS run_heartbeat_at,
         ${taskEndColumns},
         to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM picked t
       LEFT JOIN LATERAL (SELECT status,started_at,deadline,heartbeat_at FROM runs
         WHERE task_id=t.id AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1) r ON true
       ${taskEndJoins}
       ORDER BY t.updated_at DESC,t.id DESC`,
      [
        query.filter === "closed" ? endedStatuses : null,
        query.group ?? null,
        query.project ?? null,
        query.q || null,
        query.before ?? null,
        query.beforeId ?? null,
        pageSize + 1,
      ],
    );
    const last = rows[pageSize - 1];
    return {
      tasks: rows
        .slice(0, pageSize)
        .map(({ cursor_time, ...task }) => withTaskEnd(task)),
      // 保留資料庫的微秒精度，同一時間更新的任務再用編號決定順序。
      next:
        rows.length > pageSize
          ? { before: last.cursor_time, beforeId: last.id }
          : null,
    };
  });
  app.get("/api/tasks/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    // 連結裡的任務編號不完整或打錯時，直接說找不到，不顯示「輸入格式錯誤」。
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) throw new AppError(404, "找不到任務，連結可能不完整");
    return tasks.detail(id.data);
  });
  app.get("/api/tasks/:id/runs/:runId/events", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    const p = z
      .object({ id: z.string().uuid(), runId: z.string().uuid() })
      .parse(req.params);
    const q = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    return tasks.runEvents(p.id, p.runId, q.before);
  });
  app.post("/api/alerts/seen", async (req) => {
    const user = await requireUser(db, req);
    await db.query(
      "INSERT INTO alert_seen(user_id,seen_at) VALUES($1,now()) ON CONFLICT(user_id) DO UPDATE SET seen_at=now()",
      [user.user_id],
    );
    return { ok: true };
  });
  app.post("/api/tasks/batch-end", async (req) => {
    const actor = await requireAdmin(db, req);
    return tasks.batchEnd(BatchEnd.parse(req.body), actor.login);
  });
  app.post("/api/tasks/:id/actions", async (req) => {
    const actor = await requireUser(db, req);
    const b = z
      .object({
        action: z.enum([
          "approve",
          "reject",
          "cancel",
          "retry",
          "amend",
          "assumption",
          "assign",
          "bind_assign",
          "adopt",
          "mode",
          "target",
          "reopen",
        ]),
        version: z.number().int().positive(),
        mode: z.enum(["change", "query"]).optional(),
        summary: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        project_id: z.string("請選擇專案").uuid("請選擇有效的專案").optional(),
        binding_version: z.number().int().positive().optional(),
        config_version: z.number().int().positive().optional(),
        target_branch: z.string().max(200).optional(),
        remember: z.string().optional(),
        index: z.number().int().optional(),
        value: z.string().trim().min(1).max(500).optional(),
      })
      .parse(req.body);
    if (b.action === "bind_assign" && actor.role !== "admin")
      throw new AppError(403, "只有管理者可以綁定並指定專案，請聯絡管理者");
    return tasks.action(
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b.action,
      b.version,
      actor.login,
      b,
      "dashboard",
    );
  });
  // 直接回答補問：系統把回答併進需求，不用編輯整份需求。
  app.post("/api/tasks/:id/answer", async (req) => {
    const actor = await requireUser(db, req);
    const b = z
      .object({
        text: z.string().min(1).max(2000),
        version: z.number().int().positive(),
      })
      .parse(req.body);
    return answerFromDashboard(
      db,
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b.version,
      b.text,
      actor.login,
    );
  });
  // 接錯題時改正：改接到同群組另一題，或改成新話題。
  app.post("/api/tasks/:id/relink", async (req) => {
    const actor = await requireUser(db, req);
    const b = z
      .object({
        parent_id: z.string().uuid().nullable(),
        version: z.number().int().positive(),
      })
      .parse(req.body);
    return relinkTask(
      db,
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      b.version,
      b.parent_id,
      actor.login,
    );
  });
  // 對已回答的查詢追問：建立新的一題，原回答保留。
  app.post("/api/tasks/:id/followup", async (req) => {
    const actor = await requireUser(db, req);
    const { text } = z
      .object({ text: z.string().min(1).max(2000) })
      .parse(req.body);
    return createFollowup(
      db,
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      text,
      actor.login,
    );
  });
  app.get("/api/messages/:id/image", async (req, reply) => {
    await requireUser(db, req);
    const m = await db.one<{ image: Buffer; image_mime: string }>(
      "SELECT image,image_mime FROM messages WHERE id=$1 AND NOT revoked AND received_at>message_retention_cutoff()",
      [(req.params as { id: string }).id],
    );
    if (!m?.image) throw new AppError(404, "圖片已到期、撤回或尚未取得");
    reply.header("Cache-Control", "no-store").type(m.image_mime).send(m.image);
  });
  app.get("/api/tasks/:id/report-images/:imageId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    const p = z
      .object({ id: z.string().uuid(), imageId: z.string().uuid() })
      .parse(req.params);
    const image = await db.one<{ data: Buffer; mime: string }>(
      "SELECT data,mime FROM query_report_images WHERE task_id=$1 AND id=$2 AND query_report_image_visible(id)",
      [p.id, p.imageId],
    );
    if (!image) throw new AppError(404, "圖片已到期、撤回或不屬於目前需求版本");
    return reply.type(image.mime).send(image.data);
  });
  app.get("/api/tasks/:id/branches", async (req, reply) => {
    await requireUser(db, req);
    reply.header("Cache-Control", "no-store");
    return tasks.branches(
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
    );
  });
  app.get("/api/repositories", async (req) => {
    await requireAdmin(db, req);
    return github.repos();
  });
  // 專案表單選基底分支用；即時查詢 GitHub，不走辨識用的短暫快取。
  app.get("/api/repositories/branches", async (req, reply) => {
    await requireAdmin(db, req);
    const { repo } = z.object({ repo: RepoName }).parse(req.query);
    reply.header("Cache-Control", "no-store");
    return github.branches({ repo });
  });
  app.post("/api/projects", async (req) => {
    await requireAdmin(db, req);
    const p = ProjectInput.parse(req.body);
    if (p.enabled) throw new AppError(409, "建立後須先驗證專案環境");
    // 同一個儲存庫（不分大小寫）只能有一個專案，與 PUT 改指時的檢查一致；先查再問 GitHub，
    // 已被佔用時不必多打一次 API。佔用的專案找不到儲存庫時，引導去改指那個專案。
    const taken = () =>
      db.one<Pick<Project, "id" | "name" | "repo_missing_at">>(
        "SELECT id,name,repo_missing_at FROM projects WHERE lower(repo)=lower($1)",
        [p.repo],
      );
    const duplicate = (used: Pick<Project, "name" | "repo_missing_at">) =>
      new AppError(
        409,
        used.repo_missing_at
          ? `專案「${used.name}」原本使用這個儲存庫，但目前找不到；請到該專案改選位置，不要另建新專案`
          : `已經有專案「${used.name}」使用這個儲存庫`,
      );
    const used = await taken();
    if (used) throw duplicate(used);
    // 只查此儲存庫的安裝，不逐一列出所有組織的儲存庫。
    await github.installation(p.repo);
    try {
      return await db.one(
        "INSERT INTO projects(name,repo,base_branch,image,install_command,test_command,sensitive_paths,description,index_paths,setup_mode,collect_excludes,sql_server) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [
          p.name,
          p.repo,
          p.base_branch,
          p.image,
          p.install_command,
          p.test_command,
          p.sensitive_paths,
          p.description,
          p.index_paths ?? [],
          p.setup_mode ?? "auto",
          p.collect_excludes ?? [],
          p.sql_server ?? "auto",
        ],
      );
    } catch (e) {
      // 兩個請求同時送出時，查重之後才撞到 repo 的唯一限制；一樣回 409，不落到 500。
      if ((e as { code?: string }).code !== "23505") throw e;
      const winner = await taken();
      throw winner
        ? duplicate(winner)
        : new AppError(409, "已經有專案使用這個儲存庫");
    }
  });
  app.put("/api/projects/:id", async (req) => {
    await requireAdmin(db, req);
    const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      p = ProjectInput.parse(req.body),
      old = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
    if (!old) throw new AppError(404, "找不到專案");
    // 儲存庫找得到時不能換；找不到的專案才可以改指到現在的位置或另一個儲存庫。
    let repointed: RepoLocation | null = null;
    if (p.repo !== old.repo) {
      if (!old.repo_missing_at)
        throw new AppError(409, "請新增專案以變更儲存庫");
      repointed = await github.locateRepo(p.repo);
      if (!repointed) throw new AppError(403, `GitHub App 未安裝於 ${p.repo}`);
      if (
        await db.one(
          "SELECT 1 AS used FROM projects WHERE lower(repo)=lower($1) AND id<>$2",
          [repointed.full_name, id],
        )
      )
        throw new AppError(409, "已經有另一個專案使用這個儲存庫");
    }
    // 舊版呼叫端省略時保留管理者設定；只有明確空陣列才恢復全專案。
    p.index_paths ??= old.index_paths ?? [];
    p.setup_mode ??= old.setup_mode ?? "manual";
    p.collect_excludes ??= old.collect_excludes ?? [];
    p.sql_server ??= old.sql_server ?? "auto";
    const changed =
      !!repointed ||
      [
        "base_branch",
        "setup_mode",
        "sql_server",
        "image",
        "install_command",
        "test_command",
        "sensitive_paths",
        "index_paths",
      ].some(
        (k) =>
          JSON.stringify(p[k as keyof typeof p]) !==
          JSON.stringify(old[k as keyof Project]),
      );
    if (p.enabled && (!old.validated_at || changed))
      throw new AppError(409, "請先儲存設定並重新驗證環境");
    const saved = await db.transaction(async (c) => {
      const row = (
        await c.query(
          "UPDATE projects SET name=$2,base_branch=$3,image=$4,install_command=$5,test_command=$6,sensitive_paths=$7,enabled=$8,validated_at=CASE WHEN $9 THEN NULL ELSE validated_at END,config_version=config_version+CASE WHEN $9 THEN 1 ELSE 0 END,description=$11,index_paths=$12,setup_mode=$13,setup_plan=CASE WHEN $9 THEN NULL ELSE setup_plan END,setup_status=CASE WHEN $9 THEN NULL ELSE setup_status END,setup_input=CASE WHEN $9 THEN NULL ELSE setup_input END,collect_excludes=$14,sql_server=$15 WHERE id=$1 AND config_version=$10 RETURNING *",
          [
            id,
            p.name,
            p.base_branch,
            p.image,
            p.install_command,
            p.test_command,
            p.sensitive_paths,
            p.enabled,
            changed,
            old.config_version,
            p.description,
            p.index_paths,
            p.setup_mode,
            p.collect_excludes,
            p.sql_server,
          ],
        )
      ).rows[0] as Project | undefined;
      if (!row || !repointed) return row;
      // row.repo 還是舊路徑；改指與復原在同一個交易裡完成。
      await repointRepo(c, row, repointed);
      return (await c.query("SELECT * FROM projects WHERE id=$1", [id]))
        .rows[0] as Project;
    });
    if (!saved) throw new AppError(409, "專案設定已更新，請重新整理");
    return saved;
  });
  // 完全存取：工作容器每個階段都可連所有網路，並取得專案登記的資料庫連線（帳號權限照登記的帳號）。
  app.put("/api/projects/:id/full-access", async (req) => {
    const admin = await requireAdmin(db, req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const project = await db.one<Project>(
      "UPDATE projects SET full_access=$2 WHERE id=$1 RETURNING *",
      [id, enabled],
    );
    if (!project) throw new AppError(404, "找不到專案");
    await db.audit(
      null,
      "settings",
      enabled
        ? `管理者 ${admin.login} 開啟專案 ${project.name} 的完全存取：工作容器每個階段都可連公司內網、Tailscale 與網際網路，並以環境變數取得專案登記的資料庫連線（權限照登記的帳號）`
        : `管理者 ${admin.login} 關閉專案 ${project.name} 的完全存取`,
    );
    return { id: project.id, full_access: project.full_access };
  });
  app.post("/api/projects/:id/validate", async (req, reply) => {
    await requireAdmin(db, req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    if (!enqueueValidation) throw new AppError(503, "工作佇列尚未啟動");
    // 「重新檢查」先問 GitHub 儲存庫現在在哪；搬家或改名的話直接接回，再照常驗證環境。
    const missing = await db.one<Project>(
      "SELECT * FROM projects WHERE id=$1 AND repo_missing_at IS NOT NULL",
      [id],
    );
    if (missing)
      try {
        const found = await github.locateRepo(
          missing.repo,
          missing.repo_id ? Number(missing.repo_id) : null,
        );
        if (found) await db.transaction((c) => repoFound(c, id, found));
      } catch {
        // 查不到就照常驗證，由驗證結果說明原因。
      }
    const queued = await enqueueValidation(id);
    return reply.code(202).send({
      ok: true,
      message: queued === false ? "已在驗證中" : "你的專案已排入環境驗證。",
    });
  });
  // 只有找不到儲存庫的專案可以刪除；歷史任務保留，只是不再掛在這個專案下。
  app.delete("/api/projects/:id", async (req) => {
    await requireAdmin(db, req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    return db.transaction(async (c) => {
      const p = (
        await c.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [id])
      ).rows[0] as Project | undefined;
      if (!p) throw new AppError(404, "找不到專案");
      if (!p.repo_missing_at)
        throw new AppError(409, "只有找不到儲存庫的專案可以刪除");
      const active = await c.query(
        "SELECT 1 FROM tasks WHERE project_id=$1 AND status IN ('running','reviewing') LIMIT 1",
        [id],
      );
      if (active.rowCount)
        throw new AppError(409, "還有任務正在執行，請等它結束後再刪除");
      // 找不到時先保留的待合併任務，專案刪掉後就沒有 PR 可以追蹤了。
      const closed = await c.query<{ id: string }>(
        "UPDATE tasks SET status='closed',updated_at=now() WHERE project_id=$1 AND status='ready' RETURNING id",
        [id],
      );
      for (const t of closed.rows)
        await db.audit(
          t.id,
          "closed",
          `專案「${p.name}」已刪除，${p.repo} 的 PR 不再追蹤`,
          c,
        );
      await c.query("UPDATE tasks SET project_id=NULL WHERE project_id=$1", [
        id,
      ]);
      await c.query("DELETE FROM projects WHERE id=$1", [id]);
      await db.audit(
        null,
        "project_deleted",
        `已刪除專案「${p.name}」（${p.repo}）；歷史任務保留`,
        c,
      );
      return { ok: true };
    });
  });
  app.put("/api/groups/:id", async (req) => {
    await requireAdmin(db, req);
    const b = z
      .object({
        name: z.string().min(1).max(100),
        project_ids: z.array(z.string().uuid()).max(30),
        trigger_mode: z.enum(["auto", "command"]).optional(),
        reply_mode: z.enum(["off", "results", "all"]).optional(),
        enabled: z.boolean(),
      })
      .parse(req.body);
    const ids = [...new Set(b.project_ids)];
    const found = ids.length
      ? await db.query<Project>("SELECT * FROM projects WHERE id=ANY($1)", [
          ids,
        ])
      : [];
    if (found.length !== ids.length) throw new AppError(404, "找不到專案");
    const missing = found.find((p) => p.repo_missing_at);
    if (missing)
      throw new AppError(
        409,
        `專案「${missing.name}」的儲存庫目前找不到，無法綁定`,
      );
    if (b.enabled && !found.some((p) => p.validated_at && p.enabled))
      throw new AppError(409, "請至少綁定一個已驗證並啟用的專案");
    return db.transaction(async (c) => {
      const id = (req.params as { id: string }).id;
      const old = (
        await c.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!old) throw new AppError(404, "找不到群組");
      if (b.enabled && old.left_at)
        throw new AppError(409, "機器人已離開這個群組，重新邀請加入後才能啟用");
      const mode = b.trigger_mode ?? old.trigger_mode;
      const resetPending =
        old.enabled !== b.enabled || mode !== old.trigger_mode;
      // 啟用前累積的訊息不追溯判讀；移除專案時，已排程到該專案的工作改為待審核。
      if (resetPending)
        await c.query("UPDATE messages SET processed=true WHERE group_id=$1", [
          id,
        ]);
      await c.query(
        "DELETE FROM group_projects WHERE group_id=$1 AND NOT(project_id=ANY($2))",
        [id, ids],
      );
      for (const p of ids)
        await c.query(
          "INSERT INTO group_projects(group_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [id, p],
        );
      await db.audit(
        null,
        "group_settings",
        `群組「${b.name}」設定已更新；${mode === "command" ? "只用 /任務 觸發" : "自動辨識"}`,
        c,
      );
      return (
        await c.query(
          "UPDATE groups SET name=$2,enabled=$3,first_pending_at=CASE WHEN $4 THEN NULL ELSE first_pending_at END,last_pending_at=CASE WHEN $4 THEN NULL ELSE last_pending_at END,trigger_mode=$5,trigger_version=trigger_version+1,triage_failures=CASE WHEN $4 THEN 0 ELSE triage_failures END,triage_error=CASE WHEN $4 THEN NULL ELSE triage_error END,reply_mode=$6 WHERE id=$1 RETURNING *",
          [
            id,
            b.name,
            b.enabled,
            resetPending,
            mode,
            b.reply_mode ?? old.reply_mode,
          ],
        )
      ).rows[0];
    });
  });
  app.post("/api/groups/:id/memories", async (req) => {
    await requireAdmin(db, req);
    const id = (req.params as { id: string }).id;
    const b = z
      .object({
        content: z.string().trim().min(2).max(1000),
        project_id: z.string().uuid().nullable(),
      })
      .parse(req.body);
    if (b.project_id) {
      const bound = await db.query(
        "SELECT 1 FROM group_projects WHERE group_id=$1 AND project_id=$2",
        [id, b.project_id],
      );
      if (!bound.length) throw new AppError(409, "此群組未綁定該專案");
    }
    const m = await db.one(
      "INSERT INTO group_memories(group_id,project_id,content,source) VALUES($1,$2,$3,'admin') RETURNING *",
      [id, b.project_id, b.content],
    );
    await db.audit(null, "memory", `管理者新增群組記憶：${b.content}`);
    return m;
  });
  app.post("/api/projects/:id/knowledge", async (req) => {
    await requireAdmin(db, req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const b = z
      .object({ content: z.string().trim().min(2).max(1000) })
      .parse(req.body);
    const k = await db.one(
      "INSERT INTO project_knowledge(project_id,content,source) SELECT id,$2,'admin' FROM projects WHERE id=$1 RETURNING *",
      [id, b.content],
    );
    if (!k) throw new AppError(404, "找不到專案");
    await db.audit(null, "knowledge", `管理者新增專案記憶：${b.content}`);
    return k;
  });
  app.delete("/api/knowledge/:id", async (req) => {
    await requireAdmin(db, req);
    // 只移除系統紀錄；已合併進 AGENTS.md 的內容需在儲存庫中修改。
    const k = await db.one<{ content: string }>(
      "DELETE FROM project_knowledge WHERE id=$1 RETURNING content",
      [
        z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id),
      ],
    );
    if (!k) throw new AppError(404, "找不到專案記憶");
    await db.audit(null, "knowledge", `管理者刪除專案記憶：${k.content}`);
    return { ok: true };
  });
  app.delete("/api/memories/:id", async (req) => {
    await requireAdmin(db, req);
    const m = await db.one<{ content: string }>(
      "DELETE FROM group_memories WHERE id=$1 RETURNING content",
      [
        z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id),
      ],
    );
    if (!m) throw new AppError(404, "找不到記憶");
    await db.audit(null, "memory", `管理者刪除群組記憶：${m.content}`);
    return { ok: true };
  });
  app.put("/api/memories/:id", async (req) => {
    await requireAdmin(db, req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const b = z
      .object({
        content: z.string().trim().min(2).max(1000),
        project_id: z.string().uuid().nullable(),
      })
      .parse(req.body);
    const current = await db.one<{ group_id: string }>(
      "SELECT group_id FROM group_memories WHERE id=$1",
      [id],
    );
    if (!current) throw new AppError(404, "找不到記憶");
    if (b.project_id) {
      const bound = await db.query(
        "SELECT 1 FROM group_projects WHERE group_id=$1 AND project_id=$2",
        [current.group_id, b.project_id],
      );
      if (!bound.length) throw new AppError(409, "此群組未綁定該專案");
    }
    // 管理者修改後視為管理者確認的記憶。
    const m = await db.one(
      "UPDATE group_memories SET content=$2,project_id=$3,source='admin' WHERE id=$1 RETURNING *",
      [id, b.content, b.project_id],
    );
    await db.audit(null, "memory", `管理者修改群組記憶：${b.content}`);
    return m;
  });
  app.post("/api/groups/:id/retry", async (req) => {
    await requireAdmin(db, req);
    await db.query(
      "UPDATE groups SET triage_failures=0,triage_error=NULL,triage_retry_at=NULL,first_pending_at=(SELECT min(received_at) FROM messages WHERE group_id=$1 AND NOT processed AND NOT revoked),last_pending_at=(SELECT max(received_at) FROM messages WHERE group_id=$1 AND NOT processed AND NOT revoked) WHERE id=$1",
      [(req.params as { id: string }).id],
    );
    await db.audit(null, "triage_retry", "管理者重新啟動群組需求辨識");
    return { ok: true };
  });
  app.put("/api/settings", async (req) => {
    const admin = await requireAdmin(db, req);
    const b = z
      .object({
        paused: z.boolean(),
        triage_paused: z.boolean().optional(),
        auto_memory: z.boolean().optional(),
        code_downloads: z.boolean().optional(),
        group_replies: z.boolean().optional(),
        container_network: z.enum(["isolated", "open"]).optional(),
        rag_enabled: z.boolean().optional(),
        ai_mode: z.enum(["subscription", "api"]),
        daily_runs: z.number().int().min(1).max(200),
        codex_model: z
          .string()
          .regex(
            /^[\w.-]{1,80}$/,
            "Codex 模型名稱請填 1 到 80 個英數字、底線、句點或連字號",
          )
          .refine(
            (model) => !containsCredential(model),
            "Codex 模型名稱不可包含憑證",
          )
          .nullable(),
        triage_effort: z.enum(efforts),
        coding_effort: z.enum(efforts),
        daily_budget: z.number().min(0.1).max(1000),
        task_budget: z.number().min(0.1).max(100),
        task_minutes: z.number().int().min(1).max(30),
        triage_model: z.enum(["gpt-5.4-mini", "gpt-6.1-sol"]),
        coding_model: z.enum(["gpt-5.4-mini", "gpt-6.1-sol"]),
      })
      .parse(req.body);
    if (b.task_budget > b.daily_budget)
      throw new AppError(400, "單次額度不可高於每日額度");
    if (!b.paused) {
      const s = secrets();
      if (
        (b.ai_mode === "api" && !s.openaiKey) ||
        !s.lineToken ||
        !s.lineSecret ||
        !s.githubAppId ||
        !s.githubPrivateKey
      )
        throw new AppError(409, "請先完成所有串接設定");
      // 只檢查目前模式需要的 AI 服務：API 模式查金鑰，訂閱模式查服務的 Codex 登入。
      const checked = await db.one<{ ok: boolean }>(
        "SELECT COALESCE(bool_and(ok),false) AND count(*)=4 AS ok FROM service_health WHERE name IN ($1,'github','line','runner') AND checked_at>now()-interval '1 day'",
        [b.ai_mode === "api" ? "openai" : "codex"],
      );
      if (!checked.ok) throw new AppError(409, "請先執行串接檢查");
    }
    // 同一個語句先鎖住、讀出舊值再更新，稽核寫的差異才對得上這次實際的改動。
    // CTE 不叫 old：PostgreSQL 18 起 RETURNING 的 old／new 是保留別名。
    const { before } = await db.one<{ before: Partial<Settings> }>(
      `WITH prev AS (SELECT value FROM settings WHERE id=1 FOR UPDATE)
       UPDATE settings s SET value=s.value || $1::jsonb FROM prev WHERE s.id=1
       RETURNING prev.value AS before`,
      [JSON.stringify(b)],
    );
    await db.audit(
      null,
      "settings",
      `管理者 ${admin.login} 更新工作流程設定：${describeChanges(settingsDiff(before, b))}`,
    );
    if (b.paused && !before.paused)
      await db.audit(null, "settings", "暫停新派工");
    return { ok: true };
  });
  app.put("/api/settings/line-push", async (req) => {
    const admin = await requireAdmin(db, req);
    const range = "LINE 保留給群組回覆的比例請填 0 到 100 的整數";
    const changes = z.object({
      line_private_mode: z.enum(linePrivateModes, "請選擇 LINE 私訊範圍"),
      line_group_reserve_percent: z.number(range).int(range).min(0, range).max(100, range),
    }).parse(req.body);
    await db.transaction(async (c) => {
      const { rows: [{ value: before }] } = await c.query<{ value: Partial<Settings> }>(
        "SELECT value FROM settings WHERE id=1 FOR UPDATE",
      );
      const diff = settingsDiff(before, changes);
      if (!diff.length) return;
      await c.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
        JSON.stringify(changes),
      ]);
      await db.audit(
        null,
        "settings",
        `管理者 ${admin.login} 更新 LINE 推播設定：${describeChanges(diff)}`,
        c,
      );
    });
    return { ok: true };
  });
  app.post("/api/notifications/retry", async (req) => {
    const actor = await requireAdmin(db, req);
    // 額度用完時歸零只會讓通知再失敗 3 次，先說明原因。
    if (await lineQuotaBlocked(db)) throw new AppError(409, quotaRetryBlocked);
    const result = await db.transaction<NotificationRetryResult>(async (c) => {
      // 先略過過時的通知（舊的排隊說明、舊版補問、超過一天的訊息），再只重排重試 3 次仍失敗的。
      const expired = await expireStaleNotifications(c);
      const reset = (
        await c.query<{ group_id: string | null }>(
          "UPDATE notifications SET attempts=0,last_error=NULL WHERE sent_at IS NULL AND attempts>=3 RETURNING group_id",
        )
      ).rows;
      const group = reset.filter((r) => r.group_id).length;
      return { direct: reset.length - group, group, expired };
    });
    await db.audit(
      null,
      "notification_retry",
      `${actor.login} 重送失敗的 LINE 通知：私訊 ${result.direct} 則、群組 ${result.group} 則，略過已過期 ${result.expired} 則`,
    );
    return result;
  });
  app.post("/api/notifications/test", async (req) => {
    await requireAdmin(db, req);
    await line.sendTest();
    return { ok: true };
  });
  app.post("/api/pairing", async (req) => {
    await requireAdmin(db, req);
    const code = token().slice(0, 16);
    await db.transaction(async (c) => {
      await c.query("DELETE FROM pairing_codes");
      await c.query(
        "INSERT INTO pairing_codes(code_hash,expires_at) VALUES($1,now()+interval '10 minutes')",
        [hash(code)],
      );
    });
    return { code, expiresIn: 600 };
  });
  // 錯誤處理器設定之後才註冊，輸入格式錯誤才會回 400。
  registerCapacity(app, db, () => runner.call("resources", {}, 5000));
  // Docker 磁碟用量、空間提醒與清理規則；清理一律先預覽、由管理者確認。
  registerDockerDisk(app, db, runnerCall);
  // 下載來源白名單：安裝階段與系統套件共用；變更寫稽核並同步到 egress。
  registerEgress(app, db, runnerCall);
  // 訂閱額度、重置時間與可用模型，由主機執行器以服務登入向 Codex 查詢。
  app.get("/api/system", async (req) => {
    await requireAdmin(db, req);
    // 執行器沒回應、Docker 沒回應或逾時都回 200 與 runner.state，看板才分得出是哪一段出問題。
    const c = config();
    const [status, entry] = await Promise.all([
      probeSystem(c.runnerUrl, secrets().runnerSecret ?? "", c.instance),
      currentEntry(secrets(), join(dirname(secretsPath), "tunnel-status.json")),
    ]);
    return { ...status, entry };
  });
  app.get("/api/codex/account", async (req) => {
    await requireUser(db, req);
    const fresh = (req.query as { fresh?: string }).fresh === "1";
    const r = await fetch(
      `${config().runnerUrl}/codex/account${fresh ? "?fresh=1" : ""}`,
      {
        headers: { "x-runner-key": secrets().runnerSecret ?? "" },
        signal: AbortSignal.timeout(40000),
      },
    );
    const data = (await r.json()) as { error?: string };
    if (!r.ok)
      throw new AppError(r.status, data.error ?? "無法讀取 Codex 額度");
    return data;
  });
  app.put("/api/settings/codex-reserve", async (req) => {
    const admin = await requireAdmin(db, req);
    const rangeMessage = "Codex 個人保留比例請填 0 到 90 的整數";
    const changes = z
      .object({
        codex_reserve_percent: z
          .number(rangeMessage)
          .int(rangeMessage)
          .min(0, rangeMessage)
          .max(maxCodexReserve, rangeMessage),
      })
      .parse(req.body);
    await db.transaction(async (c) => {
      // 設定與快取一起生效，舊比例的額度查詢也不能在儲存後寫回快取。
      await lockSubscriptionGate(c);
      const before = (
        await c.query<{ value: Partial<Settings> }>(
          "SELECT value FROM settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0].value;
      const diff = settingsDiff(before, changes);
      if (!diff.length) return;
      await c.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
        JSON.stringify(changes),
      ]);
      await c.query("DELETE FROM service_health WHERE name=$1", [
        subscriptionGateName,
      ]);
      await db.audit(
        null,
        "settings",
        `管理者 ${admin.login} 更新 Codex 訂閱額度：${describeChanges(diff)}`,
        c,
      );
    });
    return { ok: true };
  });
  app.post("/api/integrations/check", async (req) => {
    await requireAdmin(db, req);
    await checkIntegrations(db, github, embedder);
    return db.query("SELECT * FROM service_health");
  });
  if (existsSync(resolve("dist/web"))) {
    await app.register(serveStatic, { root: resolve("dist/web") });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith("/api/") ||
        req.url.startsWith("/internal/") ||
        req.url.startsWith("/webhooks/")
      )
        return reply.code(404).send({ error: "找不到此介面" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
