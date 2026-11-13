import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Project } from "../shared/types.js";
import {
  snapshotDirectory,
  type ConnectionTestResult,
  type DatabaseConnectionView,
  type ProjectDatabaseView,
  type SchemaSnapshotView,
  type SnapshotSummary,
} from "../shared/project-database.js";
import { AppError } from "./policy.js";
import { requireAdmin } from "./auth.js";
import { secrets } from "./config.js";
import { Database } from "./db.js";
import type { CaptureInput } from "./database-capture.js";
import type { SchemaCapture } from "./sqlserver-schema.js";

/**
 * 擁有者登記的專案資料庫連線與結構快照。
 * 連線機密加密後保存，只在呼叫主機執行器時解開；API、日誌、AI 提示詞與工作容器都拿不到。
 * 這兩張表不進每日備份：還原後重新登記連線、重新擷取即可。
 */
type Secret = {
  password: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  sshPassword?: string;
};
export interface ConnectionRow {
  project_id: string;
  engine: "sqlserver";
  host: string;
  port: number;
  database_name: string;
  username: string;
  encrypt: boolean;
  trust_server_certificate: boolean;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_username: string | null;
  ssh_host_key: string | null;
  reference_tables: string[];
  secret: Buffer;
  updated_at: Date;
  updated_by: string | null;
}
interface SnapshotRow {
  version: number;
  engine: "sqlserver";
  hash: string;
  objects: Record<string, number>;
  tables: string[];
  reference_rows: number;
  warnings: string[];
  files: Record<string, string>;
  bytes: number;
  captured_at: Date;
  captured_by: string | null;
}
type RunnerCall = <T>(
  path: string,
  body: unknown,
  timeoutMs?: number,
) => Promise<T>;

function key() {
  const secret = secrets().sessionSecret;
  if (!secret) throw new AppError(503, "尚未產生機密金鑰，無法保存連線");
  return Buffer.from(
    hkdfSync("sha256", secret, "", "agentflow/project-connection/v1", 32),
  );
}
export function seal(value: Secret) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function unseal(sealed: Buffer): Secret {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      sealed.subarray(0, 12),
    );
    decipher.setAuthTag(sealed.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(sealed.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new AppError(
      409,
      "保存的連線機密無法解開（機密金鑰已更換），請重新填寫密碼並儲存",
    );
  }
}

const host = z
  .string()
  .trim()
  .min(1, "請填主機")
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, "主機只能是主機名稱或 IP，不含通訊協定與路徑");
const port = z.number().int().min(1).max(65535);
const optionalSecret = z.string().max(20000).optional();
export const ConnectionBody = z.object({
  engine: z.literal("sqlserver"),
  host,
  port,
  database: z.string().trim().min(1, "請填資料庫名稱").max(128),
  username: z.string().trim().min(1, "請填帳號").max(128),
  password: z.string().max(512).optional(),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(true),
  referenceTables: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(260)
        .regex(/^[^;'"\s]+$/, "參考資料表名稱不可包含空白、引號或分號"),
    )
    .max(50)
    .default([]),
  ssh: z
    .object({
      host,
      port,
      username: z.string().trim().min(1, "請填 SSH 帳號").max(128),
      privateKey: optionalSecret,
      passphrase: z.string().max(512).optional(),
      password: z.string().max(512).optional(),
    })
    .nullable()
    .default(null),
});

function connectionView(row: ConnectionRow): DatabaseConnectionView {
  const secret = unsealQuietly(row.secret);
  return {
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.database_name,
    username: row.username,
    encrypt: row.encrypt,
    trustServerCertificate: row.trust_server_certificate,
    referenceTables: row.reference_tables,
    ssh: row.ssh_host
      ? {
          host: row.ssh_host,
          port: row.ssh_port ?? 22,
          username: row.ssh_username ?? "",
          auth: secret?.sshPrivateKey ? "key" : "password",
          hostKey: row.ssh_host_key,
        }
      : null,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}
function unsealQuietly(sealed: Buffer) {
  try {
    return unseal(sealed);
  } catch {
    return undefined;
  }
}
const snapshotView = (row: SnapshotRow): SchemaSnapshotView => ({
  version: row.version,
  engine: row.engine,
  hash: row.hash,
  objects: row.objects,
  referenceRows: row.reference_rows,
  warnings: row.warnings,
  bytes: row.bytes,
  capturedAt: row.captured_at.toISOString(),
  capturedBy: row.captured_by,
});
const snapshotColumns =
  "version,engine,hash,objects,tables,reference_rows,warnings,bytes,captured_at,captured_by";

export async function projectDatabaseView(
  db: Database,
  projectId: string,
): Promise<ProjectDatabaseView> {
  const connection = await db.one<ConnectionRow>(
    "SELECT * FROM project_connections WHERE project_id=$1",
    [projectId],
  );
  const snapshot = await db.one<SnapshotRow>(
    `SELECT ${snapshotColumns} FROM project_schema_snapshots WHERE project_id=$1`,
    [projectId],
  );
  return {
    connection: connection ? connectionView(connection) : null,
    snapshot: snapshot ? snapshotView(snapshot) : null,
  };
}

/** 環境規劃用的摘要：只有結構資訊，沒有任何連線資料。 */
export async function snapshotSummary(
  db: Database,
  projectId: string,
): Promise<SnapshotSummary | null> {
  const row = await db.one<SnapshotRow & { names: string[] }>(
    `SELECT ${snapshotColumns},ARRAY(SELECT jsonb_object_keys(files)) AS names FROM project_schema_snapshots WHERE project_id=$1`,
    [projectId],
  );
  if (!row) return null;
  return {
    engine: row.engine,
    version: row.version,
    hash: row.hash,
    directory: snapshotDirectory,
    files: [...row.names].sort(),
    objects: row.objects,
    tables: row.tables.slice(0, 400),
  };
}

/** 掛進工作容器的唯讀檔案；沒有快照時回傳空陣列。 */
export async function snapshotFiles(db: Database, projectId: string) {
  const row = await db.one<{ files: Record<string, string> }>(
    "SELECT files FROM project_schema_snapshots WHERE project_id=$1",
    [projectId],
  );
  return Object.entries(row?.files ?? {}).map(([name, content]) => ({
    path: `database/${name}`,
    content,
  }));
}

/** 把快照交給執行器，寫進這次執行專用的唯讀資料卷。 */
export async function provideSnapshot(
  db: Database,
  call: RunnerCall,
  projectId: string,
  runId: string,
  image: string,
) {
  const files = await snapshotFiles(db, projectId);
  if (files.length)
    await call("environment-files", { runId, image, files }, 60000);
  return files.length > 0;
}

export function captureInput(row: ConnectionRow): CaptureInput {
  const secret = unseal(row.secret);
  return {
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.database_name,
    username: row.username,
    password: secret.password,
    encrypt: row.encrypt,
    trustServerCertificate: row.trust_server_certificate,
    referenceTables: row.reference_tables,
    ssh: row.ssh_host
      ? {
          host: row.ssh_host,
          port: row.ssh_port ?? 22,
          username: row.ssh_username ?? "",
          ...(secret.sshPrivateKey
            ? {
                privateKey: secret.sshPrivateKey,
                passphrase: secret.sshPassphrase,
              }
            : { password: secret.sshPassword }),
          ...(row.ssh_host_key ? { hostKey: row.ssh_host_key } : {}),
        }
      : null,
  };
}

/** 結構改變會影響 AI 產生的環境設定：自動模式的專案作廢舊驗證，等重新驗證後才恢復派工。 */
async function invalidate(
  c: PoolClient,
  project: Project,
  status: string,
): Promise<boolean> {
  if (project.setup_mode !== "auto") return false;
  await c.query(
    "UPDATE projects SET config_version=config_version+1,validated_at=NULL,enabled=false,setup_plan=NULL,setup_input=NULL,setup_status=$2,validation_error=NULL WHERE id=$1",
    [project.id, status],
  );
  return true;
}

export function registerProjectDatabase(
  app: FastifyInstance,
  db: Database,
  call: RunnerCall,
  enqueue?: (id: string) => Promise<unknown>,
) {
  const params = (req: { params: unknown }) =>
    z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
  const project = async (id: string) => {
    const row = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
      id,
    ]);
    if (!row) throw new AppError(404, "找不到專案");
    return row;
  };
  const connection = async (id: string) => {
    const row = await db.one<ConnectionRow>(
      "SELECT * FROM project_connections WHERE project_id=$1",
      [id],
    );
    if (!row) throw new AppError(404, "這個專案還沒有登記資料庫連線");
    return row;
  };
  const revalidate = async (id: string) => {
    try {
      await enqueue?.(id);
      return !!enqueue;
    } catch {
      return false;
    }
  };

  app.get("/api/projects/:id/database", async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    await project(id);
    return projectDatabaseView(db, id);
  });

  app.put("/api/projects/:id/database", async (req, reply) => {
    const actor = await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    const body = ConnectionBody.parse(req.body);
    const target = await project(id);
    await db.transaction(async (c) => {
      const old = (
        await c.query<ConnectionRow>(
          "SELECT * FROM project_connections WHERE project_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const previous = old ? unsealQuietly(old.secret) : undefined;
      const password = body.password || previous?.password;
      if (!password) throw new AppError(422, "請填資料庫密碼");
      const secret: Secret = { password };
      let hostKey: string | null = null;
      if (body.ssh) {
        // 跳板主機或帳號沒變時，留空代表沿用已保存的憑證與主機金鑰。
        const same =
          !!old &&
          old.ssh_host === body.ssh.host &&
          old.ssh_port === body.ssh.port &&
          old.ssh_username === body.ssh.username;
        if (body.ssh.privateKey) {
          secret.sshPrivateKey = body.ssh.privateKey;
          if (body.ssh.passphrase) secret.sshPassphrase = body.ssh.passphrase;
        } else if (body.ssh.password) secret.sshPassword = body.ssh.password;
        else if (same && previous) {
          secret.sshPrivateKey = previous.sshPrivateKey;
          secret.sshPassphrase = previous.sshPassphrase;
          secret.sshPassword = previous.sshPassword;
        }
        if (!secret.sshPrivateKey && !secret.sshPassword)
          throw new AppError(422, "請提供 SSH 私鑰或密碼");
        if (same) hostKey = old.ssh_host_key;
      }
      await c.query(
        `INSERT INTO project_connections(project_id,engine,host,port,database_name,username,encrypt,trust_server_certificate,ssh_host,ssh_port,ssh_username,ssh_host_key,reference_tables,secret,updated_at,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)
         ON CONFLICT(project_id) DO UPDATE SET engine=EXCLUDED.engine,host=EXCLUDED.host,port=EXCLUDED.port,database_name=EXCLUDED.database_name,username=EXCLUDED.username,encrypt=EXCLUDED.encrypt,trust_server_certificate=EXCLUDED.trust_server_certificate,ssh_host=EXCLUDED.ssh_host,ssh_port=EXCLUDED.ssh_port,ssh_username=EXCLUDED.ssh_username,ssh_host_key=EXCLUDED.ssh_host_key,reference_tables=EXCLUDED.reference_tables,secret=EXCLUDED.secret,updated_at=now(),updated_by=EXCLUDED.updated_by`,
        [
          id,
          body.engine,
          body.host,
          body.port,
          body.database,
          body.username,
          body.encrypt,
          body.trustServerCertificate,
          body.ssh?.host ?? null,
          body.ssh?.port ?? null,
          body.ssh?.username ?? null,
          hostKey,
          body.referenceTables,
          seal(secret),
          actor.login,
        ],
      );
      await db.audit(
        null,
        "project_database",
        `已${old ? "更新" : "登記"}專案「${target.name}」的資料庫連線${body.ssh ? "（經 SSH 跳板）" : ""}`,
        c,
      );
    });
    return projectDatabaseView(db, id);
  });

  app.delete("/api/projects/:id/database", async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    const target = await project(id);
    await db.transaction(async (c) => {
      const removed = await c.query(
        "DELETE FROM project_connections WHERE project_id=$1",
        [id],
      );
      if (removed.rowCount)
        await db.audit(
          null,
          "project_database",
          `已刪除專案「${target.name}」的資料庫連線；結構快照保留`,
          c,
        );
    });
    return projectDatabaseView(db, id);
  });

  app.post("/api/projects/:id/database/test", async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    const row = await connection(id);
    const report = await call<ConnectionTestResult & { hostKey?: string }>(
      "database/test",
      captureInput(row),
      60000,
    );
    if (report.hostKey && !row.ssh_host_key)
      await db.query(
        "UPDATE project_connections SET ssh_host_key=$2 WHERE project_id=$1 AND ssh_host_key IS NULL",
        [id, report.hostKey],
      );
    const { hostKey: _hostKey, ...result } = report;
    return result;
  });

  app.post("/api/projects/:id/database/snapshot", async (req, reply) => {
    const actor = await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    const row = await connection(id);
    const captured = await call<SchemaCapture & { hostKey?: string }>(
      "database/snapshot",
      captureInput(row),
      6 * 60 * 1000,
    );
    const bytes = Object.values(captured.files).reduce(
      (n, file) => n + Buffer.byteLength(file),
      0,
    );
    const outcome = await db.transaction(async (c) => {
      const target = (
        await c.query<Project>(
          "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!target) throw new AppError(404, "找不到專案");
      if (captured.hostKey && !row.ssh_host_key)
        await c.query(
          "UPDATE project_connections SET ssh_host_key=$2 WHERE project_id=$1 AND ssh_host_key IS NULL",
          [id, captured.hostKey],
        );
      const old = (
        await c.query<{ version: number; hash: string }>(
          "SELECT version,hash FROM project_schema_snapshots WHERE project_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const changed = old?.hash !== captured.hash;
      const version = changed ? (old?.version ?? 0) + 1 : old.version;
      await c.query(
        `INSERT INTO project_schema_snapshots(project_id,version,engine,hash,objects,tables,reference_rows,warnings,files,bytes,captured_at,captured_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
         ON CONFLICT(project_id) DO UPDATE SET version=EXCLUDED.version,engine=EXCLUDED.engine,hash=EXCLUDED.hash,objects=EXCLUDED.objects,tables=EXCLUDED.tables,reference_rows=EXCLUDED.reference_rows,warnings=EXCLUDED.warnings,files=EXCLUDED.files,bytes=EXCLUDED.bytes,captured_at=now(),captured_by=EXCLUDED.captured_by`,
        [
          id,
          version,
          row.engine,
          captured.hash,
          JSON.stringify(captured.objects),
          JSON.stringify(captured.tables),
          captured.referenceRows,
          JSON.stringify(captured.warnings),
          JSON.stringify(captured.files),
          bytes,
          actor.login,
        ],
      );
      const invalidated =
        changed &&
        (await invalidate(c, target, "資料庫結構已更新，等待重新驗證"));
      await db.audit(
        null,
        "project_database",
        changed
          ? `已擷取專案「${target.name}」的資料庫結構快照（第 ${version} 版，${captured.objects.tables ?? 0} 個資料表）`
          : `重新擷取專案「${target.name}」的資料庫結構，內容沒有變化`,
        c,
      );
      return { changed, invalidated };
    });
    return {
      ...(await projectDatabaseView(db, id)),
      changed: outcome.changed,
      queued: outcome.invalidated ? await revalidate(id) : false,
    };
  });

  app.delete("/api/projects/:id/database/snapshot", async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = params(req);
    const invalidated = await db.transaction(async (c) => {
      const target = (
        await c.query<Project>(
          "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!target) throw new AppError(404, "找不到專案");
      const removed = await c.query(
        "DELETE FROM project_schema_snapshots WHERE project_id=$1",
        [id],
      );
      if (!removed.rowCount) return false;
      await db.audit(
        null,
        "project_database",
        `已刪除專案「${target.name}」的資料庫結構快照`,
        c,
      );
      return invalidate(c, target, "資料庫結構快照已刪除，等待重新驗證");
    });
    return {
      ...(await projectDatabaseView(db, id)),
      queued: invalidated ? await revalidate(id) : false,
    };
  });
}
