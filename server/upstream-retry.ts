import {
  UPSTREAM_RETRY_DELAYS,
  upstreamFailureKinds,
  type UpstreamFailure,
} from "../shared/upstream-failure.js";
import type { Database, DbClient } from "./db.js";
import { upstreamWaitText } from "./failure.js";
import { notifyGroup } from "./group-replies.js";

type RetryDecision =
  | { kind: "stale" | "scheduled" }
  | { kind: "stop"; retries: number; shortfall?: string };

export function claimUpstreamRetry(
  db: Database,
  taskId: string,
  runId: string,
  failure: UpstreamFailure,
  next: "verify" | "repair" | undefined,
  shortfall: (client: DbClient) => Promise<string>,
): Promise<RetryDecision> {
  return db.transaction(async (client) => {
    const {
      rows: [task],
    } = await client.query<{ version: number }>(
      `SELECT t.version FROM tasks t JOIN runs r ON r.task_id=t.id
       WHERE t.id=$1 AND r.id=$2 AND r.completed_at IS NULL AND r.upstream_retry_at IS NULL
       AND t.status IN ('running','reviewing') AND t.version=r.version AND t.approved_version=t.version
       FOR UPDATE OF t`,
      [taskId, runId],
    );
    if (!task) return { kind: "stale" };
    const {
      rows: [{ retries }],
    } = await client.query<{ retries: number }>(
      "SELECT count(*)::int AS retries FROM runs WHERE task_id=$1 AND version=$2 AND upstream_retry_at IS NOT NULL",
      [taskId, task.version],
    );
    const seconds = UPSTREAM_RETRY_DELAYS[retries];
    if (!upstreamFailureKinds[failure.kind].retry || seconds === undefined)
      return { kind: "stop", retries };
    const reason = await shortfall(client);
    if (reason) return { kind: "stop", retries, shortfall: reason };
    const text = upstreamWaitText(failure, seconds, next);
    await client.query(
      `WITH waiting AS (
        UPDATE tasks SET status='queued',last_error=$2,retry_at=now()+make_interval(secs=>$3),updated_at=now()
        WHERE id=$1 RETURNING retry_at
       ) UPDATE runs SET upstream_retry_at=waiting.retry_at FROM waiting WHERE id=$4`,
      [taskId, text, seconds, runId],
    );
    await db.audit(
      taskId,
      "auto_retry",
      `訂閱推論重試（版本 ${task.version}，第 ${retries + 1} 次）：${text}`,
      client,
    );
    await notifyGroup(client, taskId, "waiting", `upstream:${runId}`, text);
    return { kind: "scheduled" };
  });
}
