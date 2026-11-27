import { z } from "zod";
import type { RunEvent } from "../shared/observation.js";
import {
  WorkerThreadId,
  type WorkerEventKindLabel,
  type WorkerEventRejectionReason,
} from "../shared/worker-event.js";
import { Database } from "./db.js";
import { redact } from "./policy.js";

/** 執行紀錄與動態用：先遮蔽帳密（與其他出口同一套規則），再去掉 http 網址的查詢參數與 ANSI 控制碼。 */
export function safeDetail(value: string) {
  return redact(
    value
      .replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        try {
          const u = new URL(url);
          u.username = "";
          u.password = "";
          u.search = "";
          u.hash = "";
          return u.toString();
        } catch {
          return "[網址已省略]";
        }
      })
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""),
  ).slice(0, 6000);
}
const Event = z.object({
  seq: z.number().int().positive(),
  at: z.string().datetime(),
  phase: z.enum([
    "starting",
    "issue",
    "archive",
    "install",
    "context",
    "code",
    "collect",
    "test",
    "review",
    "publish",
    "verify",
  ]),
  kind: z.enum([
    "phase",
    "container",
    "thread",
    "command_start",
    "command_end",
    "files",
    "message",
    "usage",
    "error",
    "phase_end",
    "truncated",
    "observer_error",
    "observer_restored",
    "upstream_retry",
    "worker_event_rejected",
  ]),
  detail: z.string().max(24000).nullable().optional(),
  threadId: WorkerThreadId.optional(),
  containerId: z
    .string()
    .regex(/^[a-f0-9]{12,64}$/)
    .optional(),
  exitCode: z.number().int().nullish(),
  rejectedCount: z.number().int().positive().optional(),
});
const maxEvents = 2000;
export async function saveEvents(
  db: Database,
  runId: string,
  source: string,
  events: unknown[],
) {
  // 另留一筆截斷提示與一筆整次執行共用的拒收紀錄。
  for (const raw of events.slice(0, maxEvents + 2)) {
    const parsed = Event.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;
    await db.query(
      `INSERT INTO run_events(run_id,source,seq,at,phase,kind,detail,thread_id,container_id,exit_code,rejected_count)
      SELECT r.id,$2,$3,$4,$5,$6,CASE WHEN run_content_visible(r.id) THEN $7 ELSE NULL END,$8,$9,$10,$11
      FROM runs r WHERE r.id=$1 ON CONFLICT(run_id,source,seq) DO UPDATE SET rejected_count=EXCLUDED.rejected_count
      WHERE run_events.kind='worker_event_rejected' AND EXCLUDED.kind='worker_event_rejected'
        AND run_events.rejected_count < EXCLUDED.rejected_count`,
      [
        runId,
        source,
        e.seq,
        e.at,
        e.phase,
        e.kind,
        e.detail ? safeDetail(e.detail) : null,
        e.threadId ?? null,
        e.containerId ?? null,
        e.exitCode ?? null,
        e.rejectedCount ?? null,
      ],
    );
  }
}

// 主機執行器僅暫存有界、已遮蔽的事件，完成後由應用程式保存。
export class ObservationBuffer {
  private runs = new Map<string, {
    at: number;
    events: RunEvent[];
    rejection?: RunEvent & { rejectedCount: number };
  }>();
  private closed = new Map<string, number>();
  private activeRun(runId: string) {
    const now = Date.now();
    for (const [id, at] of this.closed)
      if (now - at > 7200000) this.closed.delete(id);
    if (this.closed.has(runId)) return;
    for (const [id, r] of this.runs)
      if (now - r.at > 7200000) this.runs.delete(id);
    if (!this.runs.has(runId)) {
      if (this.runs.size >= 64)
        this.runs.delete(this.runs.keys().next().value!);
      this.runs.set(runId, { at: now, events: [] });
    }
    return this.runs.get(runId);
  }
  rejectWorkerEvent(
    runId: string,
    phase: z.infer<typeof Event>["phase"],
    kind: WorkerEventKindLabel,
    reason: WorkerEventRejectionReason,
  ) {
    const run = this.activeRun(runId);
    if (!run) return;
    if (run.rejection) {
      run.rejection.rejectedCount++;
      return;
    }
    run.rejection = {
      seq: run.events.length + 1,
      at: new Date().toISOString(),
      phase,
      kind: "worker_event_rejected",
      rejectedCount: 1,
      detail: `容器事件已丟棄（種類：${kind}，原因：${reason}）`,
    };
    run.events.push(run.rejection);
  }
  add(
    runId: string,
    phase: string,
    event: Partial<RunEvent> & { kind: string },
  ) {
    const r = this.activeRun(runId);
    if (!r) return;
    const normalEvents = r.events.length - (r.rejection ? 1 : 0);
    if (normalEvents > maxEvents) return;
    const candidate = Event.safeParse({
      ...event,
      seq: r.events.length + 1,
      at: new Date().toISOString(),
      phase,
    });
    if (!candidate.success) return;
    const e = candidate.data;
    r.events.push(
      normalEvents === maxEvents
        ? { seq: e.seq, at: e.at, phase, kind: "truncated" }
        : { ...e, detail: e.detail ? safeDetail(e.detail) : null },
    );
  }
  read(runId: string, after = 0) {
    const run = this.runs.get(runId);
    if (run && Date.now() - run.at > 7200000) this.runs.delete(runId);
    // 拒收紀錄的序號固定；輪詢已讀過該序號時，仍須同步最新累計。
    return (this.runs.get(runId)?.events ?? []).filter(
      (e) => e.seq > after || e.kind === "worker_event_rejected",
    );
  }
  forget(runId: string) {
    this.runs.delete(runId);
    if (this.closed.size >= 64)
      this.closed.delete(this.closed.keys().next().value!);
    this.closed.set(runId, Date.now());
  }
}

export function connectionFailure(e: unknown, operation: string): Error {
  const error = e as { cause?: { code?: unknown }; name?: unknown };
  const code =
    typeof error?.cause?.code === "string" &&
    /^(E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(error.cause.code)
      ? error.cause.code
      : error?.name === "TimeoutError"
        ? "TIMEOUT"
        : "FETCH_FAILED";
  return new Error(
    `${operation}連線失敗（${code}）；請檢查執行器、網路及逾時紀錄`,
  );
}
