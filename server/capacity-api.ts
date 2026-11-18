import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireAdmin, requireUser } from "./auth.js";
import {
  DEFAULT_MAX_RUNS,
  MAX_RUNS_CAP,
  MEMORY_FLOOR_MB,
  MEMORY_RESUME_MB,
  parseResources,
  queueSnapshot,
  suggestedMaxRuns,
  withVmMemory,
} from "./capacity.js";
import type { Capacity, CapacityQueued } from "../shared/capacity.js";

/**
 * 看板「系統」頁的同時執行：目前上限、依主機的建議值、正在跑的任務與排隊順序。
 * 調整上限只改 `settings.max_runs`，不影響其他工作流程設定。
 */
export function registerCapacity(
  app: FastifyInstance,
  db: Database,
  readResources: () => Promise<unknown>,
) {
  app.get("/api/capacity", async (req): Promise<Capacity> => {
    await requireUser(db, req);
    const windows = parseResources(await readResources().catch(() => null));
    // Docker VM 可用記憶體由 app 自己讀 /proc/meminfo，只顯示、不影響暫停判斷。
    const host = windows && (await withVmMemory(windows));
    // 排隊原因與任務詳情共用同一套判斷（queueSnapshot）。
    const snapshot = await queueSnapshot(db);
    return {
      maxRuns: snapshot.limit,
      cap: MAX_RUNS_CAP,
      defaultRuns: DEFAULT_MAX_RUNS,
      memoryFloorMb: MEMORY_FLOOR_MB,
      memoryResumeMb: MEMORY_RESUME_MB,
      suggested: host ? suggestedMaxRuns(host) : null,
      host,
      hold: snapshot.hold,
      holdKind: snapshot.holdKind,
      running: snapshot.running.map(({ project_id: _, ...r }) => r),
      queued: snapshot.queued.map((t): CapacityQueued => ({
        id: t.id,
        title: t.title,
        mode: t.mode,
        project: t.project,
        created_at: t.created_at,
        reason: t.text,
        code: t.code,
        hint: t.hint,
      })),
    };
  });
  app.put("/api/capacity", async (req) => {
    await requireAdmin(db, req);
    const b = z
      .object({ max_runs: z.number().int().min(1).max(MAX_RUNS_CAP) })
      .parse(req.body);
    await db.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
      JSON.stringify(b),
    ]);
    await db.audit(null, "settings", `同時執行數改為 ${b.max_runs}`);
    return { ok: true };
  });
}
