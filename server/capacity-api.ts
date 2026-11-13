import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireAdmin, requireUser } from "./auth.js";
import {
  DEFAULT_MAX_RUNS,
  MAX_RUNS_CAP,
  MEMORY_FLOOR_MB,
  hostHold,
  maxRuns,
  parseResources,
  suggestedMaxRuns,
} from "./capacity.js";
import type {
  Capacity,
  CapacityQueued,
  CapacityRun,
} from "../shared/capacity.js";

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
    const settings = await db.settings();
    const limit = maxRuns(settings);
    const host = parseResources(await readResources().catch(() => null));
    const running = await db.query<CapacityRun & { project_id: string | null }>(
      `SELECT t.id,t.title,t.mode,t.project_id,p.name AS project,r.status AS phase,r.started_at
       FROM runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id
       WHERE r.completed_at IS NULL ORDER BY r.started_at`,
    );
    const queued = await db.query<
      Omit<CapacityQueued, "reason"> & {
        project_id: string | null;
        parent_active: boolean;
      }
    >(
      `SELECT t.id,t.title,t.mode,t.project_id,p.name AS project,t.created_at,
        (t.mode<>'query' AND EXISTS(SELECT 1 FROM tasks u WHERE u.id=t.parent_id AND u.status IN ('queued','running','reviewing','budget_wait'))) AS parent_active
       FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
       WHERE t.status='queued' ORDER BY t.created_at LIMIT 50`,
    );
    const changing = new Set(
      running.filter((r) => r.mode !== "query").map((r) => r.project_id),
    );
    let free = limit - running.length;
    return {
      maxRuns: limit,
      cap: MAX_RUNS_CAP,
      defaultRuns: DEFAULT_MAX_RUNS,
      memoryFloorMb: MEMORY_FLOOR_MB,
      suggested: host ? suggestedMaxRuns(host) : null,
      host,
      hold: await hostHold(db.pool),
      running: running.map(({ project_id: _, ...r }) => r),
      queued: queued.map(
        ({ project_id, parent_active, ...t }): CapacityQueued => {
          let reason = "等待空位";
          if (parent_active) reason = "等上一題完成";
          else if (t.mode !== "query" && changing.has(project_id))
            reason = "同專案的修改進行中";
          else if (free > 0) {
            free--;
            reason = "即將開始";
          }
          return { ...t, reason };
        },
      ),
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
