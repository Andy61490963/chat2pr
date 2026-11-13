import { createFollowup } from "./followup.js";
import { requestBackfill } from "./retrieval.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { HttpEmbedder, type Embedder } from "./embedder.js";
import { validIndexPath } from "../shared/repo-scope.js";
import { Database } from "./db.js";
import { config, secrets, token } from "./config.js";
import { registerAuth, requireAdmin, requireUser, hash } from "./auth.js";
import { registerMembers } from "./members.js";
import { checkIntegrations } from "./integrations.js";
import { registerChat } from "./chat.js";
import { registerProjectContext } from "./project-context.js";
import { registerProjectDatabase } from "./project-database.js";
import { notifyGroup } from "./group-replies.js";
import { HttpRunner, type Runner } from "./execution.js";
import { clientAddress } from "./client-address.js";
import { AppError, verifySignature, redact } from "./policy.js";
import { Line } from "./line.js";
import { Tasks } from "./tasks.js";
import { Budget } from "./budget.js";
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
import type { Action, Project } from "../shared/types.js";
import { efforts } from "../shared/types.js";
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
  enabled: z.boolean(),
});
export async function buildApp(
  db: Database,
  enqueueValidation?: (id: string) => Promise<unknown>,
  embedder: Embedder = new HttpEmbedder(),
  githubUser?: Parameters<typeof registerMembers>[2],
  runner: Pick<Runner, "call"> = new HttpRunner(),
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
  registerChat(app, db);
  registerProjectContext(app, db, enqueueValidation);
  registerProjectDatabase(
    app,
    db,
    (path, body, timeoutMs) => runner.call(path, body, timeoutMs),
    enqueueValidation,
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
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({
        error: "輸入格式錯誤",
        details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    reply.code(status).send({
      error:
        status >= 500
          ? "服務暫時無法完成操作，請檢查設定與服務狀態"
          : redact(e.message),
    });
    if (status >= 500) app.log.warn(redact(e.message));
  });
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
    // 清單預設只給最近的資料；看板按「載入更多」時才放大。
    const limits = z
      .object({
        tasks: z.coerce.number().int().min(1).max(5000).catch(250),
        activity: z.coerce.number().int().min(1).max(2000).catch(80),
      })
      .parse(req.query ?? {});
    const [
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
    ] = await Promise.all([
      db.one<{ tasks: number; activity: number; failed: number }>(
        "SELECT (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM audit) AS activity,(SELECT count(*)::int FROM notifications WHERE sent_at IS NULL AND attempts>=3) AS failed",
      ),
      // 鈴鐺：與 LINE 私訊相同的重要通知（待審核、失敗、PR 完成、查詢回覆、額度等）。
      db.query(
        "SELECT n.id,n.task_id,n.kind,n.text,n.created_at,t.title FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id ORDER BY n.created_at DESC LIMIT 30",
      ),
      db.one<{ seen_at: string }>(
        "SELECT seen_at FROM alert_seen WHERE user_id=$1",
        [user.user_id],
      ),
      db.settings(),
      db.query(
        "SELECT p.*,r.phase AS index_phase,r.chunks AS index_chunks,r.error AS index_error FROM projects p LEFT JOIN repo_indexes r ON r.project_id=p.id ORDER BY p.created_at",
      ),
      db.query(
        "SELECT g.*,COALESCE((SELECT array_agg(gp.project_id ORDER BY gp.created_at) FROM group_projects gp WHERE gp.group_id=g.id),'{}') AS project_ids,(SELECT count(*)::int FROM tasks t WHERE t.group_id=g.id AND t.status IN ('queued','budget_wait','failed','running','reviewing')) AS affected_tasks FROM groups g ORDER BY g.created_at,g.id",
      ),
      db.query("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT $1", [
        limits.tasks,
      ]),
      budget.summary(),
      db.query("SELECT * FROM service_health ORDER BY name"),
      // 動態附上任務名稱，讓人不用點開就知道是哪一件事。
      db.query(
        "SELECT a.*,t.title AS task_title FROM audit a LEFT JOIN tasks t ON t.id=a.task_id ORDER BY a.id DESC LIMIT $1",
        [limits.activity],
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
    ]);
    const s = secrets();
    return {
      settings: {
        ...settings,
        admin_line_id: settings.admin_line_id ? "已綁定" : null,
      },
      alerts,
      alertsSeenAt: seen?.seen_at ?? null,
      // 清單總筆數與送不出去的 LINE 通知數，讓看板知道還有多少沒顯示、多少要重送。
      totals: { tasks: totals?.tasks ?? 0, activity: totals?.activity ?? 0 },
      failedNotifications: totals?.failed ?? 0,
      projects,
      groups,
      tasks,
      rag,
      usage: { ...usage, runs_today: runsToday.count },
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
      void db
        .one<{ stamp: string }>(
          "SELECT concat((SELECT max(updated_at)::text FROM tasks),':',(SELECT max(id) FROM audit),':',(SELECT max(checked_at)::text FROM service_health),':',(SELECT max(id) FROM run_events),':',(SELECT max(heartbeat_at)::text FROM runs),':',(SELECT max(completed_at)::text FROM runs),':',(SELECT revision FROM chat_revision WHERE id=1)) AS stamp",
        )
        .then((r) => {
          if (r.stamp !== last) {
            last = r.stamp;
            reply.raw.write("event: update\ndata: {}\n\n");
          } else reply.raw.write(": heartbeat\n\n");
        })
        .catch(() => reply.raw.end());
    }, 5000);
    reply.raw.on("close", () => clearInterval(timer));
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
          "adopt",
          "mode",
          "target",
          "reopen",
        ]),
        version: z.number().int().positive(),
        mode: z.enum(["change", "query"]).optional(),
        summary: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        project_id: z.string().uuid().optional(),
        binding_version: z.number().int().positive().optional(),
        config_version: z.number().int().positive().optional(),
        target_branch: z.string().max(200).optional(),
        remember: z.string().optional(),
        index: z.number().int().optional(),
        value: z.string().trim().min(1).max(500).optional(),
      })
      .parse(req.body);
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
    // 只查此儲存庫的安裝，不逐一列出所有組織的儲存庫。
    await github.installation(p.repo);
    return db.one(
      "INSERT INTO projects(name,repo,base_branch,image,install_command,test_command,sensitive_paths,description,index_paths,setup_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
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
      ],
    );
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
    const changed =
      !!repointed ||
      [
        "base_branch",
        "setup_mode",
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
          "UPDATE projects SET name=$2,base_branch=$3,image=$4,install_command=$5,test_command=$6,sensitive_paths=$7,enabled=$8,validated_at=CASE WHEN $9 THEN NULL ELSE validated_at END,config_version=config_version+CASE WHEN $9 THEN 1 ELSE 0 END,description=$11,index_paths=$12,setup_mode=$13,setup_plan=CASE WHEN $9 THEN NULL ELSE setup_plan END,setup_status=CASE WHEN $9 THEN NULL ELSE setup_status END,setup_input=CASE WHEN $9 THEN NULL ELSE setup_input END WHERE id=$1 AND config_version=$10 RETURNING *",
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
    // 清掉上一次的錯誤，看板才不會在重新驗證期間顯示過期結果。
    await db.query("UPDATE projects SET validation_error=NULL WHERE id=$1", [
      id,
    ]);
    await enqueueValidation(id);
    return reply.code(202).send({ ok: true, message: "環境驗證已排程" });
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
    await requireAdmin(db, req);
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
          .regex(/^[\w.-]{1,80}$/)
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
    await db.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
      JSON.stringify(b),
    ]);
    await db.audit(
      null,
      "settings",
      b.paused ? "已暫停新派工" : "工作流程設定已更新",
    );
    return { ok: true };
  });
  app.post("/api/notifications/retry", async (req) => {
    await requireAdmin(db, req);
    await db.query(
      "UPDATE notifications SET attempts=0,last_error=NULL WHERE sent_at IS NULL",
    );
    await db.audit(null, "notification_retry", "管理者重送失敗的 LINE 通知");
    return { ok: true };
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
  // 訂閱額度、重置時間與可用模型，由主機執行器以服務登入向 Codex 查詢。
  app.get("/api/system", async (req) => {
    await requireAdmin(db, req);
    const r = await fetch(`${config().runnerUrl}/system`, {
      headers: { "x-runner-key": secrets().runnerSecret ?? "" },
      signal: AbortSignal.timeout(20000),
    });
    const data = (await r.json()) as { error?: string };
    if (!r.ok) throw new AppError(r.status, data.error ?? "無法讀取容器狀態");
    return data;
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
