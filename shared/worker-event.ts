import { z } from "zod";

export const WorkerThreadId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const commandKind = z.enum(["command_start", "command_end"]);
const detailKind = z.enum(["error", "message", "files"]);
const workerKind = z.enum(["thread", "usage", ...commandKind.options, ...detailKind.options]);
export type WorkerEventKindLabel = z.infer<typeof workerKind> | "未知";
export type WorkerEventRejectionReason = "欄位不符" | "種類不符" | "無法解析";
export type ReportWorkerRejection = (kind: WorkerEventKindLabel, reason: WorkerEventRejectionReason) => void;

// 與 worker/observe.mjs 的輸出同步。額外欄位會使整筆事件失效。
const detail = z.string().max(6000);
const workerEvent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), threadId: WorkerThreadId }),
  z.strictObject({ kind: z.literal("usage"), detail: detail.optional() }),
  z.strictObject({ kind: detailKind, detail }),
  z.strictObject({ kind: commandKind, detail, exitCode: z.int32().nullish() }),
]);

export function parseWorkerEvent(json: string, reject?: ReportWorkerRejection) {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    reject?.("未知", "無法解析");
    return;
  }
  const parsed = workerEvent.safeParse(raw);
  if (parsed.success) return parsed.data;
  const kind = workerKind.safeParse(raw && typeof raw === "object" && "kind" in raw && raw.kind);
  if (kind.success) reject?.(kind.data, "欄位不符");
  else reject?.("未知", "種類不符");
}
