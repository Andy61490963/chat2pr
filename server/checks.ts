import { z } from "zod";
import type { Database, DbClient } from "./db.js";
import { AppError, redact } from "./policy.js";
import { groupRepliesOn } from "./group-replies.js";
import { captureInput, type ConnectionRow } from "./project-database.js";
import { saveProjectConfirmation } from "./project-routing.js";
import {
  assertReadOnlySelect,
  evaluateSql,
  hostRetryMinutes,
  hostUnavailableAlertHours,
  hostUnavailablePrefix,
  inQuietHours,
  isTime,
  minIntervalMinutes,
  nextRunAt,
  type ScheduledCheck,
  type SqlCondition,
} from "../shared/checks.js";
import type { Task } from "../shared/types.js";
import {
  checkEnvironmentKey,
  checkEnvironmentPolicy,
  environmentView,
  removalText,
  type CheckEnvironmentView,
  type EnvironmentFailure,
  type KeptEnvironment,
  type RemovalReason,
} from "../shared/check-environment.js";

/**
 * 定期檢查（Issue #3）：定義經人核准後，排程到點請主機執行器執行 SQL／HTTP／TCP 探測，
 * 不呼叫 AI；狀態改變（正常→異常、異常→恢復）時才通知，異常時可自動請 AI 調查原因。
 * 探測在每個檢查專用的檢查容器裡執行（#19），環境保留重用、閒置逾時或設定改變才清除。
 */

export type RunnerCall = <T>(
  path: string,
  body: unknown,
  timeoutMs?: number,
) => Promise<T>;

/** 同時執行的檢查數、每個檢查每天的通知上限、連續失敗幾次就暫停。 */
export const checkConcurrency = 3;
export const dailyNoticeLimit = 6;
export const errorLimit = 3;

const SqlConditionSchema = z
  .object({
    column: z.string().trim().min(1).max(100),
    op: z.enum([">", ">=", "<", "<=", "=", "!="]),
    value: z.union([z.number(), z.string().max(200)]),
    listColumn: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const HttpConditionSchema = z
  .object({ contains: z.string().min(1).max(200).optional() })
  .strict();

export const CheckInput = z.object({
  group_id: z.string().min(1).max(100),
  project_id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["sql", "http", "tcp"]),
  target: z.string().trim().min(1).max(4000),
  condition: z.record(z.string(), z.unknown()).default({}),
  interval_minutes: z
    .number()
    .int()
    .min(minIntervalMinutes)
    .max(10080)
    .nullable()
    .default(null),
  daily_at: z.string().nullable().default(null),
  notify: z.enum(["group", "admin", "both"]).default("both"),
  quiet_from: z.string().nullable().default(null),
  quiet_to: z.string().nullable().default(null),
  alert_text: z.string().max(500).default(""),
  recovered_text: z.string().max(500).default(""),
  rationale: z.string().max(2000).default(""),
  investigate: z.boolean().default(true),
});
export type CheckInput = z.infer<typeof CheckInput>;

/** 檢查定義是否可用；回傳白話的錯誤，沒問題回傳 null。 */
export function checkProblem(input: CheckInput): string | null {
  if ((input.interval_minutes === null) === (input.daily_at === null))
    return "請選擇固定間隔或每天固定時間其中一種";
  if (input.daily_at !== null && !isTime(input.daily_at))
    return "每天時間請用 HH:MM（臺北時間）";
  if ((input.quiet_from === null) !== (input.quiet_to === null))
    return "靜音時段要同時填開始與結束";
  if (
    (input.quiet_from && !isTime(input.quiet_from)) ||
    (input.quiet_to && !isTime(input.quiet_to))
  )
    return "靜音時段請用 HH:MM（臺北時間）";
  if (input.kind === "sql") {
    if (!input.project_id)
      return "SQL 檢查要選擇專案，才能使用它登記的資料庫連線";
    const problem = assertReadOnlySelect(input.target);
    if (problem) return problem;
    if (!SqlConditionSchema.safeParse(input.condition).success)
      return "請設定判定條件：欄位、比較方式與門檻";
  }
  if (input.kind === "http") {
    try {
      const u = new URL(input.target);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        return "只能使用不含帳密的 http 或 https 網址";
    } catch {
      return "網址格式不正確";
    }
    if (!HttpConditionSchema.safeParse(input.condition).success)
      return "HTTP 檢查的條件只能設定「回應需包含的文字」";
  }
  if (input.kind === "tcp" && !/^[^\s:]+:\d{1,5}$/.test(input.target))
    return "TCP 檢查請填「主機:連接埠」";
  return null;
}

async function assertScope(c: DbClient, input: CheckInput) {
  const group = (
    await c.query("SELECT id FROM groups WHERE id=$1 AND left_at IS NULL", [
      input.group_id,
    ])
  ).rows[0];
  if (!group) throw new AppError(404, "找不到群組");
  if (input.project_id) {
    const bound = (
      await c.query(
        "SELECT 1 FROM group_projects WHERE group_id=$1 AND project_id=$2",
        [input.group_id, input.project_id],
      )
    ).rowCount;
    if (!bound) throw new AppError(409, "這個專案沒有綁定此群組");
  }
}

type ListedCheck = ScheduledCheck & {
  last_summary: string | null;
  /** SQL 檢查的專案沒有登記資料庫連線：不能核准或恢復。 */
  missing_connection: boolean;
  /** 目前這段連續「系統暫時無法執行」從何時開始；最近一次不是系統問題時為 null。 */
  host_unavailable_since: string | null;
  environment?: CheckEnvironmentView;
};

/** SQL 檢查沒有登記資料庫連線時，核准與恢復的錯誤（與 LINE 擬定檢查時的提醒同義）。 */
export const missingConnectionText =
  "這個專案還沒有登記資料庫連線，請先到專案頁設定資料庫連線再核准";

/** 核准或恢復前確認 SQL 檢查的專案有資料庫連線；沒有就不讓它啟用，以免每次執行都失敗。 */
async function assertSqlConnection(db: Database, id: string) {
  const row = await db.one<{ kind: string; connected: boolean }>(
    `SELECT c.kind,EXISTS(SELECT 1 FROM project_connections pc WHERE pc.project_id=c.project_id) AS connected
     FROM scheduled_checks c WHERE c.id=$1`,
    [id],
  );
  if (row?.kind === "sql" && !row.connected)
    throw new AppError(409, missingConnectionText);
}

/**
 * 主機端暫時無法執行：執行器連不上（沒有狀態碼的連線錯誤），或執行器、檢查環境回 502／503
 * （回應不完整、環境建立失敗、啟動逾時、檢查容器連不上、環境已停止）。
 * 504「檢查執行逾時」、4xx 與 500（SQL 或目標連線錯誤）仍算檢查本身的錯誤。
 */
export function isHostUnavailable(e: unknown) {
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  if (status !== undefined) return status === 502 || status === 503;
  return e instanceof Error && e.message.includes("執行器連線失敗");
}

const hostRunSql = `r.outcome='error' AND starts_with(r.summary,'${hostUnavailablePrefix}')`;

/** 檢查清單；給了執行器時附上每個檢查的環境狀態（讀不到執行器時標示未知）。 */
export async function listChecks(
  db: Database,
  call?: RunnerCall,
): Promise<ListedCheck[]> {
  const rows = await db.query<
    Omit<ListedCheck, "environment" | "host_unavailable_since"> & {
      host_unavailable_since: Date | string | null;
      conn_updated_at: Date | null;
      conn_host_key: string | null;
    }
  >(
    `SELECT c.*,(SELECT summary FROM scheduled_check_runs r WHERE r.check_id=c.id ORDER BY started_at DESC LIMIT 1) AS last_summary,
       (c.kind='sql' AND pc.project_id IS NULL) AS missing_connection,
       (SELECT min(r.started_at) FROM scheduled_check_runs r WHERE r.check_id=c.id AND r.version=c.version AND ${hostRunSql}
          AND r.id>COALESCE((SELECT max(r.id) FROM scheduled_check_runs r WHERE r.check_id=c.id AND r.version=c.version AND NOT (${hostRunSql})),0)
       ) AS host_unavailable_since,
       pc.updated_at AS conn_updated_at,pc.ssh_host_key AS conn_host_key
     FROM scheduled_checks c LEFT JOIN project_connections pc ON pc.project_id=c.project_id ORDER BY c.created_at DESC`,
  );
  const plain = rows.map(
    ({ conn_updated_at, conn_host_key, host_unavailable_since, ...c }) => ({
      check: {
        ...c,
        host_unavailable_since: host_unavailable_since
          ? new Date(host_unavailable_since).toISOString()
          : null,
      },
      connection: conn_updated_at
        ? { updated_at: conn_updated_at, ssh_host_key: conn_host_key }
        : null,
    }),
  );
  if (!call) return plain.map((p) => p.check);
  const policy = checkEnvironmentPolicy(await db.settings());
  let state:
    | { environments: KeptEnvironment[]; failures: EnvironmentFailure[] }
    | undefined;
  try {
    state = await call("checks/environments", {}, 5000);
  } catch {
    state = undefined;
  }
  return plain.map(({ check: c, connection }) => ({
    ...c,
    environment: state
      ? environmentView(
          checkEnvironmentKey(c, connection),
          state.environments.find((e) => e.checkId === c.id),
          state.failures.find((f) => f.checkId === c.id),
          policy,
        )
      : { state: "unknown", detail: "讀不到主機執行器" },
  }));
}

export async function checkDetail(db: Database, id: string) {
  const check = await db.one<ScheduledCheck>(
    "SELECT * FROM scheduled_checks WHERE id=$1",
    [id],
  );
  if (!check) throw new AppError(404, "找不到定期檢查");
  const runs = await db.query(
    "SELECT id,version,started_at,duration_ms,outcome,summary FROM scheduled_check_runs WHERE check_id=$1 ORDER BY started_at DESC LIMIT 24",
    [id],
  );
  return { check, runs };
}

/** 建立定期檢查：一律從「待核准」開始，核准前不執行。 */
export async function createCheck(
  db: Database,
  raw: unknown,
  actor: string,
  sourceTaskId: string | null = null,
  client?: DbClient,
) {
  const input = CheckInput.parse(raw);
  const problem = checkProblem(input);
  if (problem) throw new AppError(422, problem);
  const run = async (c: DbClient) => {
    await assertScope(c, input);
    const row = (
      await c.query<ScheduledCheck>(
        `INSERT INTO scheduled_checks(group_id,project_id,name,kind,target,condition,interval_minutes,daily_at,notify,quiet_from,quiet_to,alert_text,recovered_text,rationale,investigate,source_task_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          input.group_id,
          input.project_id,
          input.name,
          input.kind,
          input.target,
          JSON.stringify(input.condition),
          input.interval_minutes,
          input.daily_at,
          input.notify,
          input.quiet_from,
          input.quiet_to,
          input.alert_text,
          input.recovered_text,
          input.rationale,
          input.investigate,
          sourceTaskId,
          actor,
        ],
      )
    ).rows[0];
    await db.audit(
      null,
      "check_created",
      `${actor} 建立定期檢查「${row.name}」，等待核准`,
      c,
    );
    return row;
  };
  return client ? run(client) : db.transaction(run);
}

/** 修改任何欄位都是新版本：舊核准失效，停止執行直到重新核准。 */
export async function updateCheck(
  db: Database,
  id: string,
  version: number,
  raw: unknown,
  actor: string,
) {
  const input = CheckInput.parse(raw);
  const problem = checkProblem(input);
  if (problem) throw new AppError(422, problem);
  return db.transaction(async (c) => {
    await assertScope(c, input);
    const row = (
      await c.query<ScheduledCheck>(
        `UPDATE scheduled_checks SET group_id=$3,project_id=$4,name=$5,kind=$6,target=$7,condition=$8,interval_minutes=$9,daily_at=$10,notify=$11,
           quiet_from=$12,quiet_to=$13,alert_text=$14,recovered_text=$15,rationale=$16,investigate=$17,
           version=version+1,approved_version=NULL,approved_by=NULL,status='awaiting_approval',next_run_at=NULL,state='unknown',consecutive_errors=0,updated_at=now()
         WHERE id=$1 AND version=$2 RETURNING *`,
        [
          id,
          version,
          input.group_id,
          input.project_id,
          input.name,
          input.kind,
          input.target,
          JSON.stringify(input.condition),
          input.interval_minutes,
          input.daily_at,
          input.notify,
          input.quiet_from,
          input.quiet_to,
          input.alert_text,
          input.recovered_text,
          input.rationale,
          input.investigate,
        ],
      )
    ).rows[0];
    if (!row) throw new AppError(409, "定期檢查已被修改，請重新整理");
    await db.audit(
      null,
      "check_updated",
      `${actor} 修改定期檢查「${row.name}」，需要重新核准`,
      c,
    );
    return row;
  });
}

export async function approveCheck(
  db: Database,
  id: string,
  version: number,
  actor: string,
) {
  await assertSqlConnection(db, id);
  const row = await db.one<ScheduledCheck>(
    `UPDATE scheduled_checks SET status='active',approved_version=version,approved_by=$3,next_run_at=now(),consecutive_errors=0,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='awaiting_approval' RETURNING *`,
    [id, version, actor],
  );
  if (!row) throw new AppError(409, "這個版本不能核准，請重新整理");
  await db.audit(
    null,
    "check_approved",
    `${actor} 核准定期檢查「${row.name}」第 ${version} 版，開始執行`,
  );
  return row;
}

export async function setCheckPaused(
  db: Database,
  id: string,
  paused: boolean,
  actor: string,
) {
  // 連線可能在核准後被刪除；恢復前再確認一次，免得恢復後又連續失敗。
  if (!paused) await assertSqlConnection(db, id);
  const row = await db.one<ScheduledCheck>(
    paused
      ? "UPDATE scheduled_checks SET status='paused',next_run_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('active','failed') RETURNING *"
      : "UPDATE scheduled_checks SET status='active',next_run_at=now(),consecutive_errors=0,updated_at=now() WHERE id=$1 AND status IN ('paused','failed') AND approved_version=version RETURNING *",
    [id],
  );
  if (!row) throw new AppError(409, "目前狀態不能這樣操作");
  await db.audit(
    null,
    "check_status",
    `${actor} ${paused ? "暫停" : "恢復"}定期檢查「${row.name}」`,
  );
  return row;
}

export async function deleteCheck(db: Database, id: string, actor: string) {
  const row = await db.one<{ name: string }>(
    "DELETE FROM scheduled_checks WHERE id=$1 RETURNING name",
    [id],
  );
  if (!row) throw new AppError(404, "找不到定期檢查");
  await db.audit(null, "check_deleted", `${actor} 刪除定期檢查「${row.name}」`);
  return { ok: true };
}

type RunReply<T> = {
  result: T;
  environment?: {
    created: boolean;
    removed?: { checkId: string; reason: RemovalReason }[];
  };
};

/** 在檢查專用環境執行；新建環境時寫稽核（重用不寫）。 */
async function runInEnvironment<T>(
  db: Database,
  call: RunnerCall,
  check: ScheduledCheck,
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) {
  const policy = checkEnvironmentPolicy(await db.settings());
  const reply = await call<RunReply<T>>(
    "checks/run",
    { checkId: check.id, key, kind: check.kind, policy, ...body },
    timeoutMs,
  );
  // 為了騰出位置而清掉的其他環境（閒置或超過上限）也要記下。
  await auditRemovals(db, reply.environment?.removed ?? []);
  if (reply.environment?.created)
    await db.audit(
      null,
      "check_environment",
      `定期檢查「${check.name}」建立檢查環境（第 ${check.version} 版）`,
    );
  return reply.result;
}

/** 執行一次探測，回傳是否異常與摘要；連線失敗等執行錯誤直接丟出。 */
export async function probe(
  db: Database,
  call: RunnerCall,
  check: ScheduledCheck,
): Promise<{ alert: boolean; summary: string }> {
  if (check.kind === "sql") {
    const row = await db.one<ConnectionRow>(
      "SELECT * FROM project_connections WHERE project_id=$1",
      [check.project_id],
    );
    if (!row) throw new AppError(409, "專案沒有登記資料庫連線");
    const { rows } = await runInEnvironment<{
      rows: Record<string, unknown>[];
    }>(
      db,
      call,
      check,
      checkEnvironmentKey(check, row),
      { connection: captureInput(row), sql: check.target },
      90000,
    );
    return evaluateSql(check.condition as SqlCondition, rows);
  }
  if (check.kind === "http") {
    const contains = (check.condition as { contains?: string }).contains;
    const r = await runInEnvironment<{
      ok: boolean;
      status: number;
      ms: number;
      error?: string;
      missing?: boolean;
    }>(
      db,
      call,
      check,
      checkEnvironmentKey(check),
      { url: check.target, contains },
      60000,
    );
    return {
      alert: !r.ok,
      summary: r.error
        ? `HTTP ${r.error}`
        : `HTTP ${r.status}${r.missing ? `，回應沒有「${contains}」` : ""}，${r.ms} ms`,
    };
  }
  const [host, port] = check.target.split(":");
  const r = await runInEnvironment<{ ok: boolean; ms: number }>(
    db,
    call,
    check,
    checkEnvironmentKey(check),
    { host, port: Number(port) },
    60000,
  );
  return {
    alert: !r.ok,
    summary: r.ok ? `連線成功，${r.ms} ms` : "連不上",
  };
}

/** 試跑：只回報結果，不改變狀態、不通知、不記錄。 */
export async function testCheck(db: Database, call: RunnerCall, id: string) {
  const { check } = await checkDetail(db, id);
  try {
    const r = await probe(db, call, check);
    return { outcome: r.alert ? "alert" : "ok", summary: redact(r.summary) };
  } catch (e) {
    return {
      outcome: "error",
      summary: redact(e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
  }
}

async function notifyCheck(
  c: DbClient,
  check: ScheduledCheck,
  key: string,
  text: string,
  quiet: boolean,
) {
  // 每個檢查每天最多幾則，避免異常來回跳動時洗版與耗盡推播額度。
  const sent = Number(
    (
      await c.query(
        "SELECT count(*) AS n FROM notifications WHERE dedupe_key LIKE $1 AND created_at>now()-interval '24 hours'",
        [`%check:${check.id}:%`],
      )
    ).rows[0].n,
  );
  if (sent >= dailyNoticeLimit) return false;
  if (check.notify !== "group" || quiet)
    await c.query(
      "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES(NULL,'check',$1,$2) ON CONFLICT DO NOTHING",
      [`check:${check.id}:${key}`, text],
    );
  if (check.notify !== "admin" && !quiet)
    await c.query(
      `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id)
       SELECT NULL,'group_check',$2,$3,g.id FROM groups g
       WHERE g.id=$1 AND g.left_at IS NULL AND ${groupRepliesOn} AND g.reply_mode<>'off'
       ON CONFLICT DO NOTHING`,
      [check.group_id, `group:check:${check.id}:${key}`, text],
    );
  return true;
}

/**
 * 異常時建立唯讀查詢任務請 AI 調查原因；每個檢查每天最多一次（由呼叫端判斷）。
 * 專案停用、未驗證或群組不可用時不建立，回傳 false；通知文字依回傳值決定要不要承諾回報。
 */
async function investigate(
  db: Database,
  c: DbClient,
  check: ScheduledCheck,
  summary: string,
  now: Date,
): Promise<boolean> {
  const project = (
    await c.query<{ binding_version: number }>(
      `SELECT g.binding_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id JOIN groups g ON g.id=gp.group_id
       WHERE p.id=$1 AND g.id=$2 AND p.enabled AND p.validated_at IS NOT NULL AND g.left_at IS NULL AND g.enabled`,
      [check.project_id, check.group_id],
    )
  ).rows[0];
  if (!project) return false;
  const how =
    check.kind === "sql"
      ? `執行的唯讀查詢：\n${check.target.slice(0, 1500)}`
      : `檢查對象：${check.target}`;
  const t = (
    await c.query<Task>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,risk_reasons,missing,source_ids,status,approved_version,dedupe_key,suggestions,mode)
       VALUES($1,$2,$3,$4,$5,'[]','[]','{}','queued',1,$6,'[]','query') RETURNING *`,
      [
        check.project_id,
        check.group_id,
        `調查：${check.name}異常`,
        `定期檢查「${check.name}」判定異常：${summary}\n${how}\n請調查可能原因與影響範圍，並建議處理方式。只讀取資料，不要修改任何東西。`,
        JSON.stringify(["說明可能原因", "列出受影響範圍", "建議處理方式"]),
        `check-investigation:${check.id}:${Date.now()}`,
      ],
    )
  ).rows[0];
  const routing = {
    status: "clear",
    basis: "explicit",
    reason: `定期檢查「${check.name}」所屬的專案`,
    evidence: [],
    bindingVersion: project.binding_version,
  };
  await c.query("UPDATE tasks SET project_routing=$2 WHERE id=$1", [
    t.id,
    JSON.stringify(routing),
  ]);
  t.project_routing = routing as Task["project_routing"];
  await c.query(
    "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,1,$2,$3,'定期檢查')",
    [t.id, t.summary, JSON.stringify(t.acceptance)],
  );
  const fresh = (await c.query<Task>("SELECT * FROM tasks WHERE id=$1", [t.id]))
    .rows[0];
  await saveProjectConfirmation(c, fresh, "evidence", "定期檢查");
  await db.audit(
    t.id,
    "check_investigation",
    `定期檢查「${check.name}」異常，自動建立調查`,
    c,
  );
  // 與 24 小時判斷用同一個時間來源（傳入的 now）。
  await c.query(
    "UPDATE scheduled_checks SET last_investigated_at=$2 WHERE id=$1",
    [check.id, now],
  );
  return true;
}

/** 執行一個到期的檢查並更新狀態；狀態改變才通知。 */
export async function runCheck(
  db: Database,
  call: RunnerCall,
  check: ScheduledCheck,
  now = new Date(),
) {
  const started = Date.now();
  let outcome: "ok" | "alert" | "error";
  let summary: string;
  let host = false;
  try {
    const r = await probe(db, call, check);
    outcome = r.alert ? "alert" : "ok";
    summary = redact(r.summary).slice(0, 500);
  } catch (e) {
    outcome = "error";
    host = isHostUnavailable(e);
    summary =
      (host ? hostUnavailablePrefix : "") +
      redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  await db.transaction(async (c) => {
    const current = (
      await c.query<ScheduledCheck>(
        "SELECT * FROM scheduled_checks WHERE id=$1 FOR UPDATE",
        [check.id],
      )
    ).rows[0];
    // 執行期間被修改、暫停或刪除：結果作廢，不通知。
    if (
      !current ||
      current.status !== "active" ||
      current.version !== check.version
    )
      return;
    const run = (
      await c.query<{ id: string }>(
        "INSERT INTO scheduled_check_runs(check_id,version,started_at,duration_ms,outcome,summary) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [check.id, check.version, now, Date.now() - started, outcome, summary],
      )
    ).rows[0];
    const next = nextRunAt(current, now);
    if (host) {
      // 系統問題和檢查本身無關：不累計、不歸零連續失敗，不改狀態；退避後重試，恢復後自動繼續。
      const recent = (
        await c.query<{ outcome: string; summary: string; started_at: Date }>(
          "SELECT outcome,summary,started_at FROM scheduled_check_runs WHERE check_id=$1 AND version=$2 ORDER BY id DESC LIMIT 50",
          [check.id, check.version],
        )
      ).rows;
      const streak: Date[] = [];
      for (const r of recent) {
        if (
          r.outcome !== "error" ||
          !r.summary.startsWith(hostUnavailablePrefix)
        )
          break;
        streak.push(new Date(r.started_at));
      }
      const retry = new Date(
        Math.min(
          next.getTime(),
          now.getTime() + hostRetryMinutes(streak.length) * 60000,
        ),
      );
      await c.query(
        "UPDATE scheduled_checks SET last_run_at=$2,next_run_at=$3,updated_at=now() WHERE id=$1",
        [check.id, now, retry],
      );
      // 連續超過門檻時寫一次稽核（剛跨過門檻的那一次），看板也會標示需要處理；仍不暫停。
      const limit = hostUnavailableAlertHours * 3600000;
      const since = streak.at(-1)!.getTime();
      const previous = streak[1]?.getTime();
      if (
        now.getTime() - since > limit &&
        previous !== undefined &&
        previous - since <= limit
      )
        await db.audit(
          null,
          "check_host_unavailable",
          `定期檢查「${current.name}」已超過 ${hostUnavailableAlertHours} 小時因系統問題無法執行（不計入連續失敗、未暫停）：${summary.slice(hostUnavailablePrefix.length)}\n請到系統頁確認執行器與 Docker。`,
          c,
        );
      return;
    }
    if (outcome === "error") {
      const errors = current.consecutive_errors + 1;
      const stop = errors >= errorLimit;
      await c.query(
        "UPDATE scheduled_checks SET consecutive_errors=$2,last_run_at=$3,next_run_at=$4,status=$5,updated_at=now() WHERE id=$1",
        [check.id, errors, now, stop ? null : next, stop ? "failed" : "active"],
      );
      // 檢查本身壞了（連不上資料庫、逾時）和設備異常是兩回事，只通知管理者並暫停。
      if (stop) {
        await c.query(
          "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES(NULL,'check',$1,$2) ON CONFLICT DO NOTHING",
          [
            `check:${check.id}:failed:${run.id}`,
            `定期檢查「${current.name}」連續 ${errorLimit} 次執行失敗，已暫停：${summary}\n請到看板確認設定或連線後恢復。`,
          ],
        );
        await db.audit(
          null,
          "check_failed",
          `定期檢查「${current.name}」連續失敗，已暫停：${summary}`,
          c,
        );
      }
      return;
    }
    const state = outcome === "alert" ? "alert" : "ok";
    const turnedBad = state === "alert" && current.state !== "alert";
    const recovered = state === "ok" && current.state === "alert";
    await c.query(
      "UPDATE scheduled_checks SET state=$2,consecutive_errors=0,last_run_at=$3,next_run_at=$4,updated_at=now() WHERE id=$1",
      [check.id, state, now, next],
    );
    if (!turnedBad && !recovered) return;
    const quiet = inQuietHours(current, now);
    // 先決定會不會真的調查，再組通知文字：只在實際建立調查時才承諾「結果會再回報」。
    let investigation = "";
    if (turnedBad && current.investigate && current.project_id) {
      const recent =
        current.last_investigated_at !== null &&
        now.getTime() - new Date(current.last_investigated_at).getTime() <=
          86400000;
      if (recent)
        investigation = "\n今天稍早已調查過這項檢查，這次不重複調查。";
      else if (await investigate(db, c, current, summary, now))
        investigation = "\nAI 正在調查可能原因，結果會再回報。";
    }
    const text = turnedBad
      ? `⚠️ ${current.alert_text || `定期檢查「${current.name}」發現異常`}\n${summary}${investigation}`
      : `✅ ${current.recovered_text || `定期檢查「${current.name}」已恢復正常`}`;
    const sent = await notifyCheck(c, current, `${run.id}`, text, quiet);
    if (!sent)
      await db.audit(
        null,
        "check_capped",
        `定期檢查「${current.name}」今天的通知已達上限，這次狀態改變未通知`,
        c,
      );
  });
}

/** 排程：找出到期的檢查（群組、專案仍可用、系統未暫停），同時最多執行 3 個。 */
export async function runDueChecks(db: Database, call: RunnerCall) {
  const due = await db.query<ScheduledCheck>(
    `SELECT c.* FROM scheduled_checks c JOIN groups g ON g.id=c.group_id
     WHERE c.status='active' AND c.next_run_at<=now() AND g.enabled AND g.left_at IS NULL
       AND NOT COALESCE((SELECT (value->>'paused')::boolean FROM settings WHERE id=1),false)
       AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id
            WHERE gp.group_id=c.group_id AND gp.project_id=c.project_id AND p.enabled))
     ORDER BY c.next_run_at LIMIT $1`,
    [checkConcurrency],
  );
  await Promise.all(
    due.map(async (check) => {
      const lock = await db.pool.connect();
      try {
        const ok = (
          await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
            `check:${check.id}`,
          ])
        ).rows[0].ok;
        if (!ok) return;
        try {
          await runCheck(db, call, check);
        } finally {
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
            `check:${check.id}`,
          ]);
        }
      } finally {
        lock.release();
      }
    }),
  );
  // 這輪有檢查因連續錯誤暫停時，它的環境要立即清除。
  if (due.length) await syncCheckEnvironments(db, call).catch(() => {});
  // 暫停期間錯過的次數不補跑：恢復後從現在起算。
  await db.query(
    `UPDATE scheduled_checks c SET next_run_at=now() FROM groups g
     WHERE g.id=c.group_id AND c.status='active' AND c.next_run_at<now()-interval '1 hour'
       AND (NOT g.enabled OR COALESCE((SELECT (value->>'paused')::boolean FROM settings WHERE id=1),false))`,
  );
}

/**
 * 目前可以保留環境的檢查與環境鍵：待核准（可試跑）或執行中、群組可用、系統未暫停、
 * 專案仍啟用且綁定；SQL 檢查還要有登記的連線。不在清單內的環境由執行器立即清除。
 */
export async function validCheckEnvironments(db: Database) {
  const rows = await db.query<
    ScheduledCheck & {
      conn_updated_at: Date | null;
      conn_host_key: string | null;
    }
  >(
    `SELECT c.*,pc.updated_at AS conn_updated_at,pc.ssh_host_key AS conn_host_key
     FROM scheduled_checks c JOIN groups g ON g.id=c.group_id
     LEFT JOIN project_connections pc ON pc.project_id=c.project_id
     WHERE c.status IN ('active','awaiting_approval') AND g.enabled AND g.left_at IS NULL
       AND NOT COALESCE((SELECT (value->>'paused')::boolean FROM settings WHERE id=1),false)
       AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id
            WHERE gp.group_id=c.group_id AND gp.project_id=c.project_id AND p.enabled))
       AND (c.kind<>'sql' OR pc.project_id IS NOT NULL)`,
  );
  return rows.map((c) => ({
    checkId: c.id,
    key: checkEnvironmentKey(
      c,
      c.conn_updated_at
        ? { updated_at: c.conn_updated_at, ssh_host_key: c.conn_host_key }
        : null,
    ),
  }));
}

/** 把有效清單送給執行器，清除過期環境並寫稽核。 */
export async function syncCheckEnvironments(db: Database, call: RunnerCall) {
  const valid = await validCheckEnvironments(db);
  const policy = checkEnvironmentPolicy(await db.settings());
  const { removed } = await call<{
    removed: { checkId: string; reason: RemovalReason }[];
  }>("checks/environments/sync", { valid, policy }, 120000);
  await auditRemovals(db, removed);
  return removed;
}

async function auditRemovals(
  db: Database,
  removed: { checkId: string; reason: RemovalReason }[],
  actor?: string,
) {
  for (const r of removed) {
    const name = (
      await db.one<{ name: string }>(
        "SELECT name FROM scheduled_checks WHERE id=$1",
        [r.checkId],
      )
    )?.name;
    await db.audit(
      null,
      "check_environment",
      `${actor ? `${actor} ` : ""}清除${name ? `定期檢查「${name}」` : "已刪除定期檢查"}的檢查環境：${removalText[r.reason]}`,
    );
  }
}

/** 看板「立即清除環境」。 */
export async function clearCheckEnvironment(
  db: Database,
  call: RunnerCall,
  id: string,
  actor: string,
) {
  await checkDetail(db, id);
  const { removed } = await call<{ removed: boolean }>(
    "checks/environments/remove",
    { checkId: id },
    60000,
  );
  if (removed)
    await auditRemovals(db, [{ checkId: id, reason: "manual" }], actor);
  return { removed };
}
