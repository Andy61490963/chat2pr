import type { JobWithMetadata, PgBoss, SendOptions } from "pg-boss";
import type { Project } from "../shared/types.js";
import type { Database, DbClient } from "./db.js";
import { isTransientValidationFailure, type Execution } from "./execution.js";
import { AppError } from "./policy.js";

export type ValidationJob = {
  id: string;
  version?: number;
  progress?: string;
  /** 上一輪因 Codex 額度受阻：這一輪先確認額度再開始。 */
  resumeQuota?: boolean;
};

const queued = "你的專案正在排隊等待執行器。";
const retrying = "你的專案遇到暫時性問題，正在等待自動重試。";
const waitingForLock = "你的專案正在等待上一次驗證釋放執行環境。";
const live = "j.name='validate' AND j.state IN ('created','retry','active')";
// 舊工作可能只在去重鍵存版本，或在等鎖重排後沒有版本。
const version =
  "COALESCE(j.data->>'version',NULLIF(split_part(j.singleton_key,':',2),''))";

function queueDb(client: DbClient) {
  return {
    db: {
      executeSql: (sql: string, values?: unknown[]) =>
        client.query(sql, values),
    },
  };
}

export class ValidationQueue {
  constructor(
    private db: Database,
    private boss: Pick<PgBoss, "complete"> & {
      send(
        name: string,
        data: ValidationJob,
        options: SendOptions,
      ): Promise<string | null>;
    },
  ) {}

  enqueue = (id: string) =>
    this.db.transaction(async (c) => {
      // 鎖專案列，讓各入口的重複請求依序檢查同一份佇列。
      const project = (
        await c.query<Pick<Project, "config_version" | "setup_input">>(
          "SELECT config_version,setup_input FROM projects WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!project) throw new AppError(404, "找不到專案");
      const versionText = String(project.config_version);
      const pending = await c.query(
        `SELECT 1 FROM pgboss.job j WHERE ${live}
         AND j.data->>'id'=$1 AND COALESCE(${version},$2)=$2 LIMIT 1`,
        [id, versionText],
      );
      if (pending.rowCount) return false;
      if (project.setup_input?.configVersion === project.config_version)
        throw new AppError(409, "請先回答環境驗證的補問");
      await c.query("UPDATE projects SET validation_error=NULL WHERE id=$1", [
        id,
      ]);
      const job = await this.boss.send(
        "validate",
        { id, version: project.config_version },
        queueDb(c),
      );
      if (!job) throw new AppError(503, "環境驗證未能排程，請稍後再試");
      return true;
    });

  progress = () =>
    this.db.query<{ id: string; version: number; progress: string }>(
      `SELECT DISTINCT ON (p.id) p.id,p.config_version AS version,
        CASE WHEN j.state='retry' THEN $1 ELSE COALESCE(j.data->>'progress',$2) END AS progress
       FROM pgboss.job j JOIN projects p ON p.id::text=j.data->>'id'
       WHERE ${live} AND COALESCE(${version},p.config_version::text)=p.config_version::text
         AND p.setup_input->>'configVersion' IS DISTINCT FROM p.config_version::text
       ORDER BY p.id,j.state DESC,j.created_on,j.id`,
      [retrying, queued],
    );

  async work(
    job: JobWithMetadata<ValidationJob>,
    execution: Pick<Execution, "validate">,
  ) {
    const project = await this.db.one<Project>(
      "SELECT * FROM projects WHERE id=$1",
      [job.data.id],
    );
    const requestedVersion =
      job.data.version ?? job.singletonKey?.split(":")[1];
    if (
      !project ||
      (requestedVersion !== undefined &&
        String(requestedVersion) !== String(project.config_version))
    )
      return;
    const report = async (message: string) => {
      await this.db.query(
        `UPDATE pgboss.job SET data=jsonb_set(data,'{progress}',to_jsonb($3::text))
         WHERE name='validate' AND id=$1 AND retry_count=$2 AND state='active'`,
        [job.id, job.retryCount, message],
      );
    };
    let quotaWait: string | undefined;
    try {
      const result = await execution.validate(
        project,
        report,
        job.data.resumeQuota === true,
      );
      if (result.ok || result.waiting) return;
      if (typeof result.quota === "string") quotaWait = result.quota;
    } catch (error) {
      // 驗證已寫下原因，只有暫時性問題需要 pg-boss 退避重試。
      if (isTransientValidationFailure(error)) throw error;
      return;
    }
    // 等舊執行釋放鎖或等 Codex 額度都不消耗重試次數；在同一交易交接，避免重複請求看到空檔。
    await this.db.transaction(async (c) => {
      const active = await c.query(
        "SELECT 1 FROM pgboss.job WHERE name='validate' AND id=$1 AND retry_count=$2 AND state='active' FOR UPDATE",
        [job.id, job.retryCount],
      );
      if (!active.rowCount) return;
      const db = queueDb(c);
      const next = await this.boss.send(
        "validate",
        {
          id: project.id,
          version: project.config_version,
          progress: quotaWait ?? waitingForLock,
          ...(quotaWait ? { resumeQuota: true } : {}),
        },
        {
          ...db,
          // 額度通常要等到視窗重置，60 秒重查一次就夠；等鎖則 30 秒。
          startAfter: quotaWait ? 60 : 30,
          retryLimit: job.retryLimit - job.retryCount,
        },
      );
      if (!next) throw new AppError(503, "未能重新排入環境驗證");
      await this.boss.complete("validate", job, null, db);
    });
  }
}
