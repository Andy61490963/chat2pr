import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "../../../server/db.js";
import { staleNotification } from "../../../server/line-quota.js";
import { redact } from "../../../server/policy.js";

export async function waitForWorkDisposal(read: () => Promise<string[]>, timeout = 25_000, interval = 500) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const remaining = await read();
    const budget = deadline - performance.now();
    if (!remaining.length || budget <= 0) return remaining;
    await delay(Math.min(interval, budget));
  }
}

export type RetainedRun = { id: string; workspace: string | null; completed_at: Date | null };

export async function disposeRetainedWorkspaces(instance: string, rows: RetainedRun[], dispose: (id: string, workspace: string) => Promise<void>) {
  if (!/^verify-266-[a-z0-9-]+$/.test(instance)) throw new Error("只能回收本次驗收副本");
  for (const row of rows) {
    if (row.completed_at && /^[a-f0-9-]{36}$/.test(row.id) && row.workspace === `agentflow-${instance}-job-${row.id}`)
      await dispose(row.id, row.workspace);
  }
}

export interface FlowEvidence {
  stranded: number;
  stale: number;
  leaks: number;
  resources: readonly string[];
  states: readonly string[];
  audit: readonly string[];
  events: readonly string[];
  messages: readonly string[];
}

export async function settleFlowEvidence(read: () => Promise<FlowEvidence>, timeout = 25_000, interval = 500) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const evidence = await read();
    const remaining = deadline - performance.now();
    if (evidence.leaks || !(evidence.stale || evidence.resources.length) || remaining <= 0) return evidence;
    await delay(Math.min(interval, remaining));
  }
}

export async function readFlowEvidence(db: Database, messages: readonly string[], resources: readonly string[], canaries: readonly string[]): Promise<FlowEvidence> {
  const counts = await db.one<Pick<FlowEvidence, "stranded" | "stale" | "leaks">>(`
    SELECT (SELECT count(*)::int FROM tasks t WHERE status IN ('queued','running','reviewing')
              AND (retry_at IS NULL OR retry_at <= now())
              AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.completed_at IS NULL)) AS stranded,
           (SELECT count(*)::int FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id
              WHERE n.sent_at IS NULL AND n.attempts<3 AND ${staleNotification}) AS stale,
           (SELECT count(*)::int FROM (SELECT last_error AS text FROM tasks UNION ALL SELECT detail FROM audit
              UNION ALL SELECT detail FROM run_events UNION ALL SELECT text FROM notifications UNION ALL SELECT last_error FROM notifications) output
              WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS needle WHERE needle<>'' AND strpos(output.text,needle)>0)) AS leaks`, [[...canaries]]);
  const tail = async (sql: string) => (await db.query<{ text: string }>(sql)).map(row => row.text);
  return { ...counts, messages, resources,
    states: await tail("SELECT id::text || ' ' || status AS text FROM tasks ORDER BY updated_at DESC,id LIMIT 5"),
    audit: await tail("SELECT kind || ' ' || detail AS text FROM audit ORDER BY id DESC LIMIT 5"),
    events: await tail("SELECT phase || ' ' || kind || ' ' || coalesce(detail,'') AS text FROM run_events ORDER BY id DESC LIMIT 5"),
  };
}

export function checkFlowEvidence(evidence: FlowEvidence, canaries: readonly string[]) {
  const violations: string[] = [];
  if (evidence.stranded) violations.push(`有 ${evidence.stranded} 個任務沒有執行或排定重試`);
  if (evidence.stale) violations.push(`有 ${evidence.stale} 則過期通知仍可補送`);
  if (evidence.resources.length) violations.push(`有 ${evidence.resources.length} 個工作資源未釋放`);
  if (evidence.leaks || evidence.messages.some(text => canaries.some(key => key && text.includes(key)))) violations.push("輸出含虛構憑證");
  return violations;
}

export function formatFlowFailure(step: string, evidence: FlowEvidence, canaries: readonly string[]) {
  const safe = (input: string) => redact(canaries.filter(Boolean).reduce((text, key) => text.replaceAll(key, "[已遮蔽]"), input)).slice(0, 320);
  const format = (rows: readonly string[]) => rows.map(safe).join("；") || "尚無紀錄";
  return [`步驟：${safe(step)}`, `任務：${format(evidence.states)}`, `最近稽核：${format(evidence.audit)}`, `最近執行事件：${format(evidence.events)}`, `最近群組訊息：${format(evidence.messages.slice(-5))}`, ...checkFlowEvidence(evidence, canaries), ...(evidence.resources.length ? [`未釋放：${format(evidence.resources.slice(0, 10))}`] : [])].join("\n");
}
