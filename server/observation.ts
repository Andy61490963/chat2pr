import { z } from "zod";
import type { RunEvent } from "../shared/observation.js";
import { Database } from "./db.js";
import { redact } from "./policy.js";

export function safeDetail(value: string) {
  return redact(
    value
      .replace(
        /-----BEGIN [^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\n]*PRIVATE KEY-----|$)/g,
        "[已遮蔽私鑰]",
      )
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[已遮蔽權杖]")
      .replace(
        /((?:authorization|access_token|refresh_token|id_token|api[_-]?key|password|secret|auth)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi,
        "$1[已遮蔽]",
      )
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [已遮蔽]")
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
  ]),
  detail: z.string().max(24000).nullable().optional(),
  threadId: z.string().uuid().optional(),
  containerId: z
    .string()
    .regex(/^[a-f0-9]{12,64}$/)
    .optional(),
  exitCode: z.number().int().optional(),
});
export async function saveEvents(
  db: Database,
  runId: string,
  source: string,
  events: unknown[],
) {
  for (const raw of events.slice(0, 2001)) {
    const parsed = Event.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;
    await db.query(
      `INSERT INTO run_events(run_id,source,seq,at,phase,kind,detail,thread_id,container_id,exit_code)
      SELECT r.id,$2,$3,$4,$5,$6,CASE WHEN run_content_visible(r.id) THEN $7 ELSE NULL END,$8,$9,$10
      FROM runs r WHERE r.id=$1 ON CONFLICT(run_id,source,seq) DO NOTHING`,
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
      ],
    );
  }
}

// 主機執行器僅暫存有界、已遮蔽的事件，完成後由應用程式保存。
export class ObservationBuffer {
  private runs = new Map<string, { at: number; events: RunEvent[] }>();
  private closed = new Map<string, number>();
  add(
    runId: string,
    phase: string,
    event: Partial<RunEvent> & { kind: string },
  ) {
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
    const r = this.runs.get(runId)!;
    if (r.events.length > 2000) return;
    const candidate = Event.safeParse({
      ...event,
      seq: r.events.length + 1,
      at: new Date().toISOString(),
      phase,
    });
    if (!candidate.success) return;
    const e = candidate.data;
    r.events.push(
      r.events.length === 2000
        ? { seq: 2001, at: e.at, phase, kind: "truncated" }
        : { ...e, detail: e.detail ? safeDetail(e.detail) : null },
    );
  }
  read(runId: string, after = 0) {
    const run = this.runs.get(runId);
    if (run && Date.now() - run.at > 7200000) this.runs.delete(runId);
    return (this.runs.get(runId)?.events ?? []).filter((e) => e.seq > after);
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
