import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { config } from "./config.js";
import { requireAdmin } from "./auth.js";
import { AppError } from "./policy.js";
import {
  classifyDisk,
  cleanupPlan,
  diskLevel,
  diskRules,
  diskUsage,
  mergeDiskSettings,
  nextCleanupAt,
  ownerLabels,
  ruleLabels,
  workspaceVolumeRun,
  type DiskItem,
  type DiskLevel,
  type DiskOwner,
  type DiskReport,
  type DiskSettings,
  type DiskSpace,
  type DockerDiskInventory,
} from "../shared/docker-disk.js";

/**
 * Docker 磁碟管理（應用程式端）：盤點、空間不足提醒、清理規則與看板確認後的清理。
 * 實際的 Docker 操作都在主機執行器（server/docker-cleanup.ts），並由執行器再核對一次歸屬。
 */

type Call = <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;
type Db = Pick<Database, "query" | "one" | "audit">;
export interface DiskOptions {
  now?: Date;
  /** 服務資料所在的 Docker 磁碟；測試時注入。 */
  appSpace?: () => Promise<DiskSpace | null>;
}

const gb = 1024 ** 3;
export const sizeText = (bytes: number) => `${(bytes / gb).toFixed(1)} GB`;

export async function readDiskSettings(db: Db) {
  const row = await db.one<{ settings: unknown }>(
    "SELECT settings FROM docker_disk WHERE id=1",
  );
  return mergeDiskSettings(row?.settings);
}

export const diskSettingsSchema = z
  .object({
    warn_percent: z.number().min(1).max(50),
    pause_percent: z.number().min(0.5).max(50),
    pause_enabled: z.boolean(),
    daily_cleanup: z.boolean(),
    rules: z.object({
      workspaces: z.object({
        enabled: z.boolean(),
        days: z.number().int().min(1).max(30),
      }),
      containers: z.object({ enabled: z.boolean() }),
      images: z.object({
        enabled: z.boolean(),
        days: z.number().int().min(3).max(365),
      }),
      build_cache: z.object({
        enabled: z.boolean(),
        limit_gb: z.number().int().min(5).max(500),
      }),
    }),
  })
  .refine((s) => s.pause_percent < s.warn_percent, {
    message: "暫停派工的門檻要低於提醒門檻",
    path: ["pause_percent"],
  });

function settingsChanges(before: DiskSettings, after: DiskSettings) {
  const on = (v: boolean) => (v ? "開啟" : "關閉");
  const changes: string[] = [];
  if (before.warn_percent !== after.warn_percent)
    changes.push(`提醒門檻 ${before.warn_percent}% → ${after.warn_percent}%`);
  if (before.pause_percent !== after.pause_percent)
    changes.push(`暫停門檻 ${before.pause_percent}% → ${after.pause_percent}%`);
  if (before.pause_enabled !== after.pause_enabled)
    changes.push(`空間不足暫停派工：${on(after.pause_enabled)}`);
  if (before.daily_cleanup !== after.daily_cleanup)
    changes.push(`既有每日清理：${on(after.daily_cleanup)}`);
  for (const rule of diskRules) {
    const b = before.rules[rule] as Record<string, unknown>,
      a = after.rules[rule] as Record<string, unknown>;
    if (b.enabled !== a.enabled)
      changes.push(`${ruleLabels[rule]}：${on(!!a.enabled)}`);
    for (const k of Object.keys(a))
      if (k !== "enabled" && b[k] !== a[k])
        changes.push(
          `${ruleLabels[rule]}的${k === "limit_gb" ? "上限" : "保留天數"} ${b[k]} → ${a[k]}`,
        );
  }
  return changes;
}

export async function saveDiskSettings(db: Db, input: unknown, actor: string) {
  const next = diskSettingsSchema.parse(input) as DiskSettings;
  const before = await readDiskSettings(db);
  await db.query("UPDATE docker_disk SET settings=$1::jsonb WHERE id=1", [
    JSON.stringify(next),
  ]);
  const changes = settingsChanges(before, next);
  if (changes.length)
    await db.audit(
      null,
      "docker_disk_settings",
      `${actor} 調整 Docker 磁碟設定：${changes.join("；")}`,
    );
  return next;
}

async function appSpace(): Promise<DiskSpace | null> {
  try {
    const s = await statfs(config().dataDir);
    return {
      label: "Docker 磁碟（服務資料所在）",
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    return null;
  }
}

async function projectImages(db: Db) {
  return (
    await db.query<{ image: string }>("SELECT DISTINCT image FROM projects")
  ).map((p) => p.image);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function buildDiskReport(
  db: Db,
  call: Call,
  options: DiskOptions = {},
) {
  const now = options.now ?? new Date();
  const inventory = await call<DockerDiskInventory>(
    "maintenance/disk/inventory",
    {},
    5 * 60_000,
  );
  const settings = await readDiskSettings(db);
  const keep = await projectImages(db);
  const runIds = new Set<string>();
  for (const c of inventory.containers) {
    const id = c.labels["io.agentflow.run"];
    if (id && uuid.test(id)) runIds.add(id);
  }
  for (const v of inventory.volumes) {
    const id = workspaceVolumeRun(v.name, inventory.instance);
    if (id) runIds.add(id);
  }
  const runs: Record<string, { completedAt: string | null }> = {};
  if (runIds.size)
    for (const r of await db.query<{ id: string; completed_at: Date | null }>(
      "SELECT id,completed_at FROM runs WHERE id=ANY($1::uuid[])",
      [[...runIds]],
    ))
      runs[r.id] = {
        completedAt: r.completed_at
          ? new Date(r.completed_at).toISOString()
          : null,
      };
  const derived: Record<string, { project: string | null; lastUsed: string }> =
    {};
  for (const d of await db.query<{
    tag: string;
    project: string | null;
    last_used_at: Date;
  }>(
    "SELECT d.tag,p.name AS project,d.last_used_at FROM derived_images d LEFT JOIN projects p ON p.id=d.project_id",
  ))
    derived[d.tag] = {
      project: d.project,
      lastUsed: new Date(d.last_used_at).toISOString(),
    };
  const items = classifyDisk(inventory, {
    instance: inventory.instance,
    now: now.getTime(),
    projectImages: keep,
    derived,
    runs,
    settings,
  });
  const spaces = [
    await (options.appSpace ?? appSpace)(),
    inventory.host,
  ].filter((s): s is DiskSpace => !!s);
  const { level, freePercent } = diskLevel(spaces, settings);
  const owners = new Map<DiskOwner, { count: number; size: number }>();
  const seenImages = new Set<string>();
  for (const item of items) {
    if (item.kind === "build_cache") continue;
    const entry = owners.get(item.owner) ?? { count: 0, size: 0 };
    entry.count++;
    if (!item.imageId || !seenImages.has(item.imageId)) entry.size += item.size;
    if (item.imageId) seenImages.add(item.imageId);
    owners.set(item.owner, entry);
  }
  const last = async (kind: string) =>
    (
      await db.one<{ at: Date | null }>(
        "SELECT max(created_at) AS at FROM audit WHERE kind=$1",
        [kind],
      )
    )?.at ?? null;
  const nexts: Date[] = [];
  if (diskRules.some((r) => settings.rules[r].enabled))
    nexts.push(nextCleanupAt(await last("docker_disk_auto"), now));
  if (settings.daily_cleanup)
    nexts.push(nextCleanupAt(await last("docker_cleanup"), now));
  const lastCleanup = await db.one<{ created_at: Date; detail: string }>(
    "SELECT created_at,detail FROM audit WHERE kind IN ('docker_cleanup','docker_disk_cleanup','docker_disk_auto') ORDER BY created_at DESC LIMIT 1",
  );
  const report: DiskReport = {
    checkedAt: inventory.checkedAt,
    instance: inventory.instance,
    settings,
    usage: diskUsage(inventory),
    spaces,
    level,
    freePercent,
    paused: level === "critical" && settings.pause_enabled,
    owners: [...owners]
      .map(([owner, v]) => ({ owner, label: ownerLabels[owner], ...v }))
      .sort((a, b) => b.size - a.size),
    candidates: cleanupPlan(items, settings, false),
    protected: items.filter((i) => i.protected),
    nextCleanupAt: nexts.length
      ? new Date(Math.min(...nexts.map((d) => d.getTime()))).toISOString()
      : null,
    lastCleanup: lastCleanup
      ? {
          at: new Date(lastCleanup.created_at).toISOString(),
          detail: lastCleanup.detail,
        }
      : null,
  };
  return { report, items, keep };
}

const rank: Record<DiskLevel, number> = {
  unknown: -1,
  ok: 0,
  low: 1,
  critical: 2,
};

/**
 * 記錄空間狀態；變差或恢復時私訊管理者一次。
 * 回升要比提醒門檻多 1 個百分點才算恢復，避免在門檻附近來回洗版。
 */
export async function recordDiskLevel(
  db: Db,
  report: Pick<DiskReport, "settings" | "spaces" | "level" | "freePercent">,
) {
  const s = report.settings;
  const previous =
    ((
      await db.one<{ level: DiskLevel }>(
        "SELECT level FROM docker_disk WHERE id=1",
      )
    )?.level as DiskLevel | undefined) ?? "unknown";
  // 讀不到空間時不覆蓋上次的狀態；checked_at 不更新，3 小時後暫停派工自動失效。
  if (report.level === "unknown") return previous;
  let level = report.level;
  if (
    level === "ok" &&
    rank[previous] > 0 &&
    report.freePercent !== null &&
    report.freePercent < s.warn_percent + 1
  )
    level = "low";
  const space = report.spaces.reduce<DiskSpace | null>(
    (worst, x) =>
      !worst || x.freeBytes / x.totalBytes < worst.freeBytes / worst.totalBytes
        ? x
        : worst,
    null,
  );
  const amount = space
    ? `${space.label}可用 ${sizeText(space.freeBytes)}／${sizeText(space.totalBytes)}（${report.freePercent}%）`
    : "讀不到可用空間";
  const paused = level === "critical" && s.pause_enabled;
  const detail =
    level === "critical"
      ? `${amount}，低於 ${s.pause_percent}%。${paused ? "已暫停派新工作，空間回升後自動恢復。" : "暫停派工未開啟，只提醒。"}`
      : level === "low"
        ? `${amount}，低於提醒門檻 ${s.warn_percent}%。`
        : amount;
  await db.query(
    "UPDATE docker_disk SET level=$1,free_percent=$2,detail=$3,checked_at=now() WHERE id=1",
    [level, report.freePercent, detail],
  );
  if (previous === level) return level;
  const worse = rank[level] > Math.max(rank[previous], 0);
  const recovered = level === "ok" && rank[previous] > 0;
  if (!worse && !recovered) return level;
  await db.query(
    "INSERT INTO notifications(kind,dedupe_key,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [
      recovered ? "disk_ok" : "disk_low",
      `disk:${level}:${randomUUID()}`,
      recovered
        ? `Docker 磁碟空間已恢復：${amount}。${previous === "critical" && s.pause_enabled ? "派工已恢復。" : ""}`
        : `Docker 磁碟空間不足：${detail}請到看板「系統」頁查看可回收的項目，確認後再清理。`,
    ],
  );
  return level;
}

/** 嚴重不足且管理者開啟了暫停派工；狀態超過 3 小時沒更新就不擋，避免執行器失聯時永遠卡住。 */
export async function diskPaused(db: Pick<Database, "one">) {
  const row = await db.one<{ paused: boolean }>(
    "SELECT level='critical' AND COALESCE((settings->>'pause_enabled')::boolean,false) AND checked_at>now()-interval '3 hours' AS paused FROM docker_disk WHERE id=1",
  );
  return !!row?.paused;
}

interface RemovalResult {
  skipped?: boolean;
  removed: string[];
  failed: { key: string; reason: string }[];
  cacheBytes: number;
}

async function removeItems(call: Call, plan: DiskItem[], keep: string[]) {
  return call<RemovalResult>(
    "maintenance/disk/remove",
    {
      keep,
      items: plan.map((i) => ({
        kind: i.kind,
        target: i.target,
        ...(i.runId && i.kind === "volume" ? { runId: i.runId } : {}),
      })),
    },
    10 * 60_000,
  );
}

function freedBytes(plan: DiskItem[], result: RemovalResult) {
  const removed = new Set(result.removed);
  const seen = new Set<string>();
  let bytes = result.cacheBytes;
  for (const i of plan) {
    if (!removed.has(i.key) || i.kind === "build_cache") continue;
    if (i.imageId) {
      if (seen.has(i.imageId)) continue;
      seen.add(i.imageId);
    }
    bytes += i.size;
  }
  return bytes;
}

export function removalSummary(plan: DiskItem[], result: RemovalResult) {
  const byKey = new Map(plan.map((i) => [i.key, i]));
  const names = result.removed.map((k) => byKey.get(k)?.name ?? k);
  const parts = [
    `刪除 ${result.removed.length} 項`,
    `約釋放 ${sizeText(freedBytes(plan, result))}`,
  ];
  if (names.length)
    parts.push(
      `${names.slice(0, 20).join("、")}${names.length > 20 ? ` 等 ${names.length} 項` : ""}`,
    );
  if (result.failed.length)
    parts.push(
      `未刪除 ${result.failed.length} 項：${result.failed
        .slice(0, 5)
        .map((f) => `${byKey.get(f.key)?.name ?? f.key}（${f.reason}）`)
        .join("、")}`,
    );
  return parts.join("；");
}

/**
 * 每小時由維護工作呼叫：只讀可用空間並提醒（不跑 docker system df，避免每小時掃過所有資料卷）；
 * 有開啟的規則時，每天盤點一次並依規則清理。
 */
export async function diskMaintenance(
  db: Db,
  call: Call,
  options: DiskOptions = {},
) {
  const settings = await readDiskSettings(db);
  const host = await call<{ space: DiskSpace | null }>(
    "maintenance/disk/space",
    {},
    30_000,
  )
    .then((r) => r.space)
    .catch(() => null);
  const spaces = [await (options.appSpace ?? appSpace)(), host].filter(
    (s): s is DiskSpace => !!s,
  );
  const level = await recordDiskLevel(db, {
    settings,
    spaces,
    ...diskLevel(spaces, settings),
  });
  const enabled = diskRules.filter((r) => settings.rules[r].enabled);
  if (!enabled.length) return { level, cleaned: false };
  const recent = await db.query(
    "SELECT 1 FROM audit WHERE kind='docker_disk_auto' AND created_at>now()-interval '23 hours' LIMIT 1",
  );
  if (recent.length) return { level, cleaned: false };
  const { items, keep } = await buildDiskReport(db, call, options);
  const plan = cleanupPlan(items, settings, true);
  const result = plan.length
    ? await removeItems(call, plan, keep)
    : { removed: [], failed: [], cacheBytes: 0 };
  if ("skipped" in result && result.skipped) return { level, cleaned: false };
  await db.audit(
    null,
    "docker_disk_auto",
    `Docker 自動清理（${enabled.map((r) => ruleLabels[r]).join("、")}）：${plan.length ? removalSummary(plan, result) : "沒有符合規則的項目"}`,
  );
  return { level, cleaned: true };
}

/** 看板「立即清理」：只刪管理者在預覽中確認、而且現在仍符合條件的項目。 */
export async function confirmedCleanup(
  db: Db,
  call: Call,
  keys: string[],
  actor: string,
  options: DiskOptions = {},
) {
  const { report, keep } = await buildDiskReport(db, call, options);
  const wanted = new Set(keys);
  const plan = report.candidates.filter((i) => wanted.has(i.key));
  const stale = keys.filter((k) => !plan.some((i) => i.key === k));
  if (!plan.length)
    throw new AppError(409, "確認的項目已不符合清理條件，請重新預覽");
  const result = await removeItems(call, plan, keep);
  if (result.skipped)
    throw new AppError(409, "驗收實例不清理共用的 Docker 資源");
  const summary = removalSummary(plan, result);
  await db.audit(
    null,
    "docker_disk_cleanup",
    `${actor} 在看板確認清理 Docker：${summary}${stale.length ? `；${stale.length} 項已變動未處理` : ""}`,
  );
  return {
    removed: result.removed,
    failed: result.failed,
    skipped: stale,
    freedBytes: freedBytes(plan, result),
    summary,
  };
}

export function registerDockerDisk(
  app: FastifyInstance,
  db: Database,
  call: Call,
  options: DiskOptions = {},
) {
  // 盤點要列出全部映像與資料卷，正式主機要十幾秒。看板打開系統頁就會要一次；
  // 快取 60 秒並讓同時的請求共用同一次盤點，避免頁面重新整理或重新掛載時一直重算、
  // 停在「盤點中」（驗收時發生）。「重新盤點」與清理前預覽帶 fresh=1 強制重算。
  let cached: { at: number; report: DiskReport } | undefined;
  let running: Promise<DiskReport> | undefined;
  const report = (fresh: boolean) => {
    if (!fresh && cached && Date.now() - cached.at < 60000)
      return Promise.resolve(cached.report);
    running ??= buildDiskReport(db, call, options)
      .then((r) => {
        cached = { at: Date.now(), report: r.report };
        return r.report;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  app.get("/api/system/disk", async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const { fresh } = z
      .object({ fresh: z.enum(["0", "1"]).optional() })
      .parse(req.query);
    return report(fresh === "1");
  });
  app.put("/api/system/disk/settings", async (req) => {
    const actor = await requireAdmin(db, req);
    const saved = await saveDiskSettings(db, req.body, actor.login ?? "管理者");
    cached = undefined;
    return saved;
  });
  app.post("/api/system/disk/cleanup", async (req) => {
    const actor = await requireAdmin(db, req);
    const { keys } = z
      .object({ keys: z.array(z.string().min(1).max(400)).min(1).max(1000) })
      .parse(req.body);
    try {
      return await confirmedCleanup(
        db,
        call,
        keys,
        actor.login ?? "管理者",
        options,
      );
    } finally {
      cached = undefined;
    }
  });
}
