import { HttpEmbedder, type Embedder } from "./embedder.js";
import { checkIntegrations } from "./integrations.js";
import { RepoIndexer, scheduleRepoIndex } from "./repo-index.js";
import { Retrieval } from "./retrieval.js";
import { PgBoss, type WorkHandler } from "pg-boss";
import { safeQueueHandler } from "./queue-error.js";
import { Database } from "./db.js";
import { config, secrets } from "./config.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { secretsPath } from "./config.js";
import { Budget } from "./budget.js";
import { GitHub } from "./github.js";
import { Line } from "./line.js";
import { tellGroupWaiting } from "./group-replies.js";
import { dueTriageGroups } from "./triage-window.js";
import {
  Triage,
  OpenAIClassifier,
  CodexClassifier,
  ModeClassifier,
} from "./triage.js";
import { Execution, HttpRunner, type Runner } from "./execution.js";
import { cleanup, backup, downloadPendingImages } from "./maintenance.js";
import { announceNewGroups, syncGroupNames } from "./line-groups.js";
import { recordHealth } from "./health.js";
import { syncOpenPullRequests } from "./pr-sync.js";
import { syncProjectRepos } from "./repo-missing.js";
import { redact } from "./policy.js";
import { SubscriptionGate, SubscriptionBlocked } from "./subscription-gate.js";
import { dailyDockerCleanup } from "./docker-cleanup.js";
import type { Project, Settings, Task } from "../shared/types.js";
export async function recoverInterrupted(
  db: Database,
  runner: Runner,
  budget: Budget,
  line: Line,
) {
  const lock = await db.pool.connect();
  try {
    if (
      !(await lock.query("SELECT pg_try_advisory_lock(73462) AS locked"))
        .rows[0].locked
    )
      return;
    const interrupted = await db.query<{
      id: string;
      task_id: string;
      reservation_id: string;
    }>("SELECT * FROM runs WHERE completed_at IS NULL");
    for (const r of interrupted) {
      await runner.call("cancel", { runId: r.id });
      await db.query(
        "UPDATE runs SET completed_at=now(),proxy_active=false,token_hash=NULL,outcome='interrupted' WHERE id=$1",
        [r.id],
      );
      await budget.recoverExpired(r.reservation_id);
      await db.query(
        "UPDATE tasks SET status='failed',last_error='服務曾中斷；重試前會先核對 GitHub PR',updated_at=now() WHERE id=$1 AND status IN ('running','reviewing')",
        [r.task_id],
      );
      await line.notify(
        r.task_id,
        "interrupted",
        `interrupted:${r.id}`,
        "執行曾中斷，請檢視並重試；系統會先核對遠端結果。",
      );
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(73462)");
    lock.release();
  }
}
export async function startJobs(
  db: Database,
  adapters: { github?: GitHub; runner?: Runner; model?: Embedder } = {},
) {
  const previous = await db.one<{ checked_at: Date }>(
    "SELECT checked_at FROM service_health WHERE name='queue'",
  );
  if (previous && Date.now() - new Date(previous.checked_at).getTime() > 60000)
    await db.audit(
      null,
      "recovery",
      `服務重新啟動；前次心跳為 ${new Date(previous.checked_at).toISOString()}`,
    );
  const boss = new PgBoss(config().databaseUrl);
  boss.on("error", (e) => {
    console.error("工作佇列：", redact(e.message));
  });
  await boss.start();
  for (const name of [
    "triage",
    "embed",
    "repo-index",
    "repo-discover",
    "execute",
    "validate",
    "maintenance",
    "pr-sync",
    "backup",
    "notifications",
    "images",
    "issues",
    "knowledge",
  ])
    await boss.createQueue(name, {
      retryLimit: name === "execute" ? 0 : 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 2400,
    });
  // 原 handler 先處理額度等控制流程，最後一層才限制佇列保存的錯誤內容。
  const work = <T>(
    name: string,
    handler: WorkHandler<T>,
    options: {
      localConcurrency?: number;
      pollingIntervalSeconds?: number;
    } = {},
  ) => boss.work<T>(name, options, safeQueueHandler(handler));
  const budget = new Budget(db),
    github = adapters.github ?? new GitHub(),
    line = new Line(db),
    runner = adapters.runner ?? new HttpRunner(),
    subscriptionGate = new SubscriptionGate(db, runner.account?.bind(runner)),
    retrieval = new Retrieval(db, adapters.model),
    triage = new Triage(
      db,
      new ModeClassifier(
        db,
        new OpenAIClassifier(budget),
        new CodexClassifier(runner),
        subscriptionGate,
      ),
      github,
      line,
      budget,
      retrieval,
    ),
    execution = new Execution(db, github, line, budget, runner, retrieval);
  await work<{ groupId: string }>(
    "triage",
    async (jobs) => {
      for (const j of jobs)
        try {
          await triage.process(j.data.groupId, true);
          // 成功也要記錄，否則設定頁永遠「未檢查」，失敗過一次後也一直停在「需處理」。
          await db.query(
            "INSERT INTO service_health(name,ok,detail) VALUES('triage',true,'最近一次判讀成功') ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail,checked_at=now()",
          );
        } catch (e) {
          await db.query(
            "INSERT INTO service_health(name,ok,detail) VALUES('triage',false,$1) ON CONFLICT(name) DO UPDATE SET ok=false,detail=$1,checked_at=now()",
            [redact(String(e))],
          );
          if (
            e instanceof SubscriptionBlocked ||
            (e instanceof Error && "statusCode" in e && e.statusCode === 429)
          )
            return;
          throw e;
        }
    },
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
  );
  await work<{ taskId: string }>(
    "execute",
    async (jobs) => {
      for (const j of jobs) await execution.execute(j.data.taskId);
    },
    { localConcurrency: 1 },
  );
  await work<{ id: string }>("validate", async (jobs) => {
    for (const j of jobs) {
      const p = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
        j.data.id,
      ]);
      if (p) {
        const result = await execution.validate(p);
        if (!result.ok && !result.waiting)
          // 舊版本還在清理時保留新版本請求；缺資料的等待狀態不重排。
          await boss.send("validate", { id: p.id }, { startAfter: 30 });
      }
    }
  });
  await work<{ id: string }>("repo-discover", async (jobs) => {
    for (const job of jobs) {
      const project = await db.one<Project>(
        "SELECT * FROM projects WHERE id=$1 AND validated_at IS NOT NULL",
        [job.data.id],
      );
      if (project && (await db.settings()).rag_enabled)
        await scheduleRepoIndex(db, project, await github.base(project));
    }
  });
  const repoIndexer = new RepoIndexer(db, github, adapters.model);
  await work("repo-index", () => repoIndexer.work(), { localConcurrency: 1 });
  await work(
    "embed",
    async () => {
      for (let batch = 0; batch < 10; batch++)
        if ((await retrieval.indexBatch()) < 16) break;
    },
    { localConcurrency: 1 },
  );
  // 已經找不到的專案每小時再找一次就好（要逐一問每個安裝）；App 裝到新地方時 Webhook 會立刻再找。
  let missingScan = 0;
  await work("pr-sync", async () => {
    const all = Date.now() - missingScan >= 3600_000;
    if (all) missingScan = Date.now();
    // 先確認每個儲存庫現在在哪；找不到的專案先不查 PR，接回後再同步。
    await syncProjectRepos(db, github, all ? "all" : "present");
    await syncOpenPullRequests(db, github);
  });
  await work("maintenance", async () => {
    await cleanup(db);
    // 每天清理一次這個系統用不到的舊映像與建置快取；失敗不影響其他維護。
    await dailyDockerCleanup(db, (path, body, timeoutMs) =>
      runner.call(path, body, timeoutMs),
    ).catch((e) => console.warn("Docker 清理失敗：", redact(String(e))));
    // 每小時重新確認外部服務，設定頁的連線狀態不會停在上次手動檢查。
    await checkIntegrations(
      db,
      github,
      adapters.model ?? new HttpEmbedder(),
    ).catch((e) => console.warn("連線檢查失敗：", redact(String(e))));
    for (const r of await db.query<{ id: string }>(
      "SELECT id FROM runs WHERE completed_at<now()-interval '30 days' AND workspace IS NOT NULL",
    )) {
      await runner.call("dispose", { runId: r.id });
      await db.query("UPDATE runs SET workspace=NULL,result=NULL WHERE id=$1", [
        r.id,
      ]);
    }
  });
  await work("backup", async () => {
    await backup(db);
  });
  await work("notifications", async () => {
    await line.flushNotifications();
  });
  await work("images", () => downloadPendingImages(db, line));
  await work<{ taskId: string }>("issues", async (jobs) => {
    for (const j of jobs) await execution.syncIssue(j.data.taskId);
  });
  await work<{ projectId: string }>("knowledge", async (jobs) => {
    for (const j of jobs)
      await syncKnowledge(db, github, line, j.data.projectId);
  });
  await boss.schedule("maintenance", "10 * * * *");
  // 每 10 分鐘確認儲存庫還在（搬家就跟過去），並補同步 PR 合併／關閉狀態，避免 Webhook 延遲時看板停在待合併。
  await boss.schedule("pr-sync", "*/10 * * * *");
  await boss.schedule("backup", "0 3 * * *", null, { tz: "Asia/Taipei" });
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await recoverInterrupted(db, runner, budget, line);
      await budget.recoverExpired();
      // 新群組第一次收到訊息後很快換成 LINE 上的名稱；之後每小時最多查一次。
      await syncGroupNames(db);
      await announceNewGroups(db);
      let tunnel = { ok: false, detail: "尚未啟動 HTTPS 隧道" };
      try {
        const state = JSON.parse(
          await readFile(
            join(dirname(secretsPath), "tunnel-status.json"),
            "utf8",
          ),
        );
        const ok =
          !!state.ok && Date.now() - Date.parse(state.checked_at) < 180000;
        tunnel = {
          ok,
          detail: ok
            ? "固定 HTTPS 入口已連線"
            : String(state.detail ?? "隧道狀態過期，請檢查網路與免費額度"),
        };
      } catch {
        // 讀不到狀態檔：隧道尚未啟動，或檔案正在改寫。
      }
      // 每分鐘檢查一次，連續兩次異常才通知管理者，避免瞬斷洗版。
      await recordHealth(db, "tunnel", tunnel.ok, tunnel.detail, {
        confirm: true,
      });
      await boss.send(
        "notifications",
        {},
        { singletonKey: "notifications", singletonSeconds: 20 },
      );
      await boss.send(
        "images",
        {},
        { singletonKey: "images", singletonSeconds: 30 },
      );
      const snapshot = await db.one<{ value: Settings; revision: string }>(
        "SELECT value,revision FROM settings WHERE id=1",
      );
      const s = snapshot.value;
      await db.query(
        "INSERT INTO service_health(name,ok,detail) VALUES('queue',true,'持久化佇列運作中') ON CONFLICT(name) DO UPDATE SET ok=true,checked_at=now()",
      );
      const due = await db.one<{ due: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM rag_pending WHERE available_at<=now() AND (backfill OR $1)) OR EXISTS(SELECT 1 FROM rag_backfill WHERE active AND NOT EXISTS(SELECT 1 FROM rag_pending WHERE backfill)) AS due",
        [s.rag_enabled],
      );
      if (due.due)
        await boss.send(
          "embed",
          {},
          { singletonKey: "embed", singletonSeconds: 10 },
        );
      if (
        s.rag_enabled &&
        (await db.one(
          "SELECT 1 FROM repo_indexes WHERE phase NOT IN ('ready','limited') AND retry_at<=now() LIMIT 1",
        ))
      )
        await boss.send(
          "repo-index",
          {},
          { singletonKey: "repo-index", singletonSeconds: 60 },
        );
      if (s.rag_enabled) {
        const unindexed = await db.query<{ id: string }>(
          "SELECT p.id FROM projects p WHERE p.validated_at IS NOT NULL AND EXISTS(SELECT 1 FROM group_projects gp WHERE gp.project_id=p.id) AND NOT EXISTS(SELECT 1 FROM repo_indexes r WHERE r.project_id=p.id)",
        );
        for (const { id } of unindexed)
          await boss.send(
            "repo-discover",
            { id },
            { singletonKey: id, singletonSeconds: 120 },
          );
      }
      if (s.paused) {
        // 暫停期間有排隊的工作就告訴群組一聲；同一群組每 6 小時最多一則。
        for (const t of await db.query<{ id: string }>(
          "SELECT DISTINCT ON (group_id) id FROM tasks WHERE status='queued' ORDER BY group_id,created_at",
        ))
          await tellGroupWaiting(db, t.id, "paused");
        return;
      }
      if (s.ai_mode !== "api") {
        try {
          await subscriptionGate.ensure();
        } catch (error) {
          if (!(error instanceof SubscriptionBlocked)) throw error;
          const held = await db.query<{ id: string; group_id: string }>(
            `UPDATE tasks SET status='budget_wait',last_error=$1,updated_at=now() WHERE status='queued'
             AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND revision=$2 AND value->>'ai_mode'<>'api' AND NOT (value->>'paused')::boolean)
             RETURNING id,group_id`,
            [error.message, snapshot.revision],
          );
          const told = new Set<string>();
          for (const t of held)
            if (!told.has(t.group_id)) {
              told.add(t.group_id);
              await tellGroupWaiting(db, t.id, "quota");
            }
          return;
        }
        // 真正重新確認訂閱額度恢復，且尚未達每日執行上限，才重新排隊。
        await db.query(
          `UPDATE tasks SET status='queued',last_error=NULL,updated_at=now() WHERE status='budget_wait'
           AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND revision=$1 AND value->>'ai_mode'<>'api' AND NOT (value->>'paused')::boolean
           AND (SELECT count(*) FROM runs WHERE (started_at AT TIME ZONE 'Asia/Taipei')::date=(now() AT TIME ZONE 'Asia/Taipei')::date)<(value->>'daily_runs')::int)`,
          [snapshot.revision],
        );
      }
      for (const k of await db.query<{ project_id: string }>(
        "SELECT DISTINCT project_id FROM project_knowledge WHERE status='pending'",
      ))
        await boss.send(
          "knowledge",
          { projectId: k.project_id },
          { singletonKey: `knowledge:${k.project_id}`, singletonSeconds: 300 },
        );
      for (const t of await db.query<{ id: string }>(
        "SELECT id FROM tasks WHERE (issue_version IS NULL OR issue_version<version) AND status='queued' AND missing='[]'::jsonb AND project_id IS NOT NULL AND task_project_confirmed(id) ORDER BY created_at LIMIT 10",
      ))
        await boss.send(
          "issues",
          { taskId: t.id },
          { singletonKey: t.id, singletonSeconds: 300 },
        );
      const tasks = await db.query<{ id: string }>(
        "SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 20",
      );
      for (const t of tasks)
        await boss.send(
          "execute",
          { taskId: t.id },
          { singletonKey: t.id, singletonSeconds: 60 },
        );
      if (s.ai_mode === "api")
        await db.query(
          "UPDATE tasks SET status='queued',last_error=NULL WHERE status='budget_wait' AND (updated_at AT TIME ZONE 'Asia/Taipei')::date<((now() AT TIME ZONE 'Asia/Taipei')::date)",
        );
      await db.query(
        "INSERT INTO service_health(name,ok,detail) VALUES('queue',true,'持久化佇列運作中') ON CONFLICT(name) DO UPDATE SET ok=true,checked_at=now()",
      );
    } catch (e) {
      console.error("排程器：", redact(String(e)));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 10000);
  await tick();
  // 判讀獨立每秒檢查，不增加其他維運工作的頻率，也不被其網路等待拖慢。
  let triageBusy: Promise<void> | undefined;
  const scheduleTriage = async () => {
    try {
      const groups = await dueTriageGroups(db);
      if (!groups.length) return;
      if ((await db.settings()).ai_mode !== "api")
        await subscriptionGate.ensure();
      for (const g of groups)
        await boss.send(
          "triage",
          { groupId: g.id },
          {
            singletonKey: g.id,
            singletonSeconds: 5,
          },
        );
    } catch (e) {
      if (!(e instanceof SubscriptionBlocked))
        console.error("判讀排程：", redact(String(e)));
    }
  };
  const triageTimer = setInterval(() => {
    if (!triageBusy)
      triageBusy = scheduleTriage().finally(() => {
        triageBusy = undefined;
      });
  }, 1000);
  await scheduleTriage();
  return {
    boss,
    enqueueValidation: async (id: string) => {
      const p = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
        id,
      ]);
      if (!p) throw new Error("找不到專案");
      return boss.send(
        "validate",
        { id },
        { singletonKey: `${id}:${p.config_version}`, singletonSeconds: 60 },
      );
    },
    stop: async () => {
      clearInterval(timer);
      clearInterval(triageTimer);
      await triageBusy;
      await boss.stop({ graceful: true, timeout: 10000 });
    },
  };
}
// 專案知識以 PR 寫進目標專案的 AGENTS.md；合併前由開發流程直接帶入提示。
export async function syncKnowledge(
  db: Database,
  github: GitHub,
  line: Line,
  projectId: string,
) {
  const project = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
    projectId,
  ]);
  const items = await db.query<{ id: string; content: string; status: string }>(
    "SELECT id,content,status FROM project_knowledge WHERE project_id=$1 AND status IN ('pending','in_pr') ORDER BY created_at",
    [projectId],
  );
  const pending = items.filter((i) => i.status === "pending");
  if (!project || !pending.length) return;
  const pr = await github.knowledgePr(project, items);
  await db.query(
    "UPDATE project_knowledge SET status='in_pr',pr_number=$2,pr_url=$3 WHERE id=ANY($1)",
    [items.map((i) => i.id), pr.number, pr.html_url],
  );
  await db.audit(
    null,
    "knowledge",
    `專案記憶已整理成 PR：${project.name} ${pr.html_url}`,
  );
  await line.notify(
    null,
    "knowledge",
    `knowledge:${projectId}:${pending.map((i) => i.id).join(",")}`,
    `「${project.name}」有 ${pending.length} 條新的專案記憶，已加進 AGENTS.md 的 PR，合併後長期生效：${pr.html_url}`,
  );
}
