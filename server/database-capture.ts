import { assertReadOnlySelect } from "../shared/checks.js";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { Client } from "ssh2";
import { Connection, Request } from "tedious";
import { z } from "zod";
import { AppError } from "./policy.js";
import { captureSqlServer, type Row } from "./sqlserver-schema.js";

/**
 * 只在可信的主機執行器內使用：連到擁有者登記的資料庫，測試連線或擷取結構。
 * 連線機密只存在這次請求的記憶體；錯誤訊息一律轉成固定的白話文字，不回顯輸入值。
 */
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, "主機名稱格式不正確");
const port = z.number().int().min(1).max(65535);
export const CaptureInput = z.object({
  engine: z.literal("sqlserver"),
  host,
  port,
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(512),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(true),
  referenceTables: z.array(z.string().max(260)).max(50).default([]),
  ssh: z
    .object({
      host,
      port,
      username: z.string().trim().min(1).max(128),
      privateKey: z.string().max(20000).optional(),
      passphrase: z.string().max(512).optional(),
      password: z.string().max(512).optional(),
      /** 第一次連線成功時記下的主機金鑰指紋；之後不同就拒絕。 */
      hostKey: z.string().max(200).optional(),
    })
    .nullable()
    .default(null),
});
export type CaptureInput = z.infer<typeof CaptureInput>;

const fail = (message: string) => new AppError(422, message);

export interface Tunnel {
  port: number;
  hostKey: string;
  close(): void;
}

/** 經 SSH 跳板開一條只通往資料庫的本機轉送；只監聽回環介面。 */
export function openTunnel(
  ssh: NonNullable<CaptureInput["ssh"]>,
  target: { host: string; port: number },
  timeoutMs = 20000,
): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let server: Server | undefined,
      hostKey = "",
      settled = false;
    const close = () => {
      server?.close();
      client.end();
    };
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };
    client.on("error", (error: Error & { level?: string }) =>
      stop(
        hostKey && ssh.hostKey && ssh.hostKey !== hostKey
          ? fail(
              "SSH 跳板的主機金鑰和上次不同，已停止連線。確認主機沒有問題後，重新儲存連線設定。",
            )
          : error.level === "client-authentication"
            ? fail("SSH 跳板拒絕登入，請檢查帳號、私鑰或密碼。")
            : fail("連不上 SSH 跳板，請檢查主機、連接埠與防火牆。"),
      ),
    );
    client.on("ready", () => {
      server = createServer((socket) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          target.host,
          target.port,
          (error, stream) => {
            if (error) return socket.destroy();
            socket.pipe(stream).pipe(socket);
            socket.on("error", () => stream.destroy());
            stream.on("error", () => socket.destroy());
          },
        );
      });
      server.on("error", () => stop(fail("無法建立本機轉送。")));
      server.listen(0, "127.0.0.1", () => {
        settled = true;
        resolve({
          port: (server!.address() as AddressInfo).port,
          hostKey,
          close,
        });
      });
    });
    try {
      client.connect({
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        ...(ssh.privateKey
          ? { privateKey: ssh.privateKey, passphrase: ssh.passphrase }
          : { password: ssh.password }),
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => {
          hostKey = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
          return !ssh.hostKey || ssh.hostKey === hostKey;
        },
      });
    } catch {
      stop(fail("SSH 私鑰格式無法讀取，或密碼片語不正確。"));
    }
  });
}

export type SqlError = Error & { code?: string; number?: number };

/** 這次連線的用途：擷取結構（含測試連線）或定期檢查的查詢；錯誤說明依用途不同。 */
export type SqlPurpose = "capture" | "check";

export interface SqlFailureContext {
  viaTunnel: boolean;
  purpose: SqlPurpose;
  /** 連線（登入）是否已完成；完成後的錯誤來自查詢本身，不再是連不上主機。 */
  connected: boolean;
}

/** SQL Server 錯誤訊息中第一個引號內的物件名稱（例如 Invalid object name 'dbo.X'），截 100 字。 */
function quotedName(message: string) {
  const m = /['‘「]([^'’」]{1,400})['’」]/.exec(message);
  return m ? m[1].slice(0, 100) : null;
}

/** 定期檢查連線完成後、查詢本身的錯誤；不認得時回傳 null，交給共用說明。 */
function checkQueryFailure(error: SqlError) {
  const n = error.number;
  if (n === 207 || n === 208) {
    const name = quotedName(error.message ?? "");
    return fail(
      `查詢的欄位或資料表不存在${name ? `：${name}` : ""}，請修正檢查 SQL。`,
    );
  }
  if (n === 102 || n === 156 || n === 170)
    return fail("檢查 SQL 語法錯誤，請修正後試跑。");
  if (n === 229 || n === 297 || n === 300)
    return fail("帳號沒有查詢這張資料表的 SELECT 權限。");
  if (n === 1222)
    return fail(
      "資料表被其他交易鎖住超過 5 秒，請避開長交易時段或縮小查詢範圍。",
    );
  if (error.code === "ETIMEOUT")
    return fail("查詢超過 60 秒仍未完成，請加條件或索引。");
  if (error.code === "ESOCKET")
    return fail("查詢途中與資料庫的連線中斷，請稍後試跑確認。");
  if (error.code === "EREQUEST")
    return fail(
      `資料庫拒絕了檢查查詢（錯誤 ${typeof n === "number" ? n : "未知"}），請試跑確認 SQL。`,
    );
  return null;
}

/**
 * 把 tedious 的錯誤轉成固定的白話說明（AppError 422）。
 * 只回固定文字、錯誤代碼與 SQL Server 訊息中引號內的物件名稱，不回連線帳密或原始連線字串。
 */
export function sqlFailure(
  error: SqlError,
  { viaTunnel, purpose, connected }: SqlFailureContext,
) {
  if (error instanceof AppError) return error;
  const message = error.message ?? "";
  if (connected && purpose === "check") {
    const known = checkQueryFailure(error);
    if (known) return known;
  }
  if (connected && purpose === "capture" && error.code === "ETIMEOUT")
    return fail("讀取結構的查詢超過時間限制，請稍後再試或減少參考資料表。");
  if (/Cannot open database/i.test(message) || error.number === 4060)
    return fail("資料庫不存在，或這個帳號沒有開啟它的權限。");
  if (/Login failed|登入失敗/i.test(message) || error.number === 18456)
    return fail("資料庫拒絕登入，請檢查帳號、密碼與資料庫名稱。");
  if (error.number === 229 || error.number === 297 || error.number === 300)
    return fail(
      "帳號權限不足：擷取結構需要資料庫的 VIEW DEFINITION 權限；參考資料表另外需要 SELECT 權限。",
    );
  if (error.code === "ETIMEOUT" || error.code === "ESOCKET")
    return fail(
      viaTunnel
        ? "SSH 跳板連得上，但從跳板連不到資料庫主機與連接埠。"
        : "連不上資料庫主機，請檢查主機、連接埠、防火牆，或改用 SSH 跳板。",
    );
  if (/certificate|TLS|SSL/i.test(message))
    return fail(
      "資料庫的加密連線建立失敗，請調整「加密連線」或「信任伺服器憑證」。",
    );
  if (error.code === "EREQUEST")
    return fail("資料庫拒絕了讀取結構的查詢，請確認帳號權限。");
  return fail("資料庫連線失敗，請檢查連線設定。");
}

/**
 * 第一段連線改走的位址：檢查容器內只能連到轉接器，轉接器再固定轉到資料庫或 SSH 跳板。
 * 經跳板時只改連跳板的位址，跳板之後仍連登記的資料庫主機。
 */
export interface FirstHop {
  host: string;
  port: number;
}

async function withSqlServer<T>(
  input: CaptureInput,
  work: (query: (sql: string, batch?: boolean) => Promise<Row[]>) => Promise<T>,
  timeoutMs: number,
  purpose: SqlPurpose,
  via?: FirstHop,
): Promise<{ value: T; hostKey?: string }> {
  const deadline = Date.now() + timeoutMs;
  let connected = false;
  const tunnel = input.ssh
    ? await openTunnel(
        via ? { ...input.ssh, host: via.host, port: via.port } : input.ssh,
        { host: input.host, port: input.port },
      )
    : undefined;
  let connection: Connection | undefined;
  try {
    connection = new Connection({
      server: tunnel ? "127.0.0.1" : (via?.host ?? input.host),
      authentication: {
        type: "default",
        options: { userName: input.username, password: input.password },
      },
      options: {
        port: tunnel ? tunnel.port : (via?.port ?? input.port),
        database: input.database,
        encrypt: input.encrypt,
        trustServerCertificate: input.trustServerCertificate,
        // 透過通道或轉接器連線時，憑證上的名稱仍是資料庫主機。
        ...(tunnel || via ? { serverName: input.host } : {}),
        readOnlyIntent: true,
        connectTimeout: 15000,
        requestTimeout: 60000,
        useColumnNames: true,
        appName: "chat2pr schema snapshot",
      },
    });
    const active = connection;
    await new Promise<void>((resolve, reject) =>
      active.connect((error) => (error ? reject(error) : resolve())),
    );
    connected = true;
    // batch：直接送出批次。execSql 會包成 sp_executesql，在裡面 BEGIN TRANSACTION
    // 會因交易數不一致被 SQL Server 拒絕（錯誤 266），交易控制必須用批次。
    const query = (sql: string, batch = false) =>
      new Promise<Row[]>((resolve, reject) => {
        if (Date.now() > deadline)
          return reject(
            fail(
              purpose === "check"
                ? "檢查超過時間限制，已停止。"
                : "擷取超過時間限制，已停止。",
            ),
          );
        const rows: Row[] = [];
        const request = new Request(sql, (error) =>
          error ? reject(error) : resolve(rows),
        );
        request.on("row", (columns: Record<string, { value: unknown }>) =>
          rows.push(
            Object.fromEntries(
              Object.entries(columns).map(([name, c]) => [name, c.value]),
            ),
          ),
        );
        if (batch) active.execSqlBatch(request);
        else active.execSql(request);
      });
    return { value: await work(query), hostKey: tunnel?.hostKey };
  } catch (error) {
    throw sqlFailure(error as SqlError, {
      viaTunnel: !!tunnel,
      purpose,
      connected,
    });
  } finally {
    connection?.close();
    tunnel?.close();
  }
}

export interface ConnectionReport {
  ok: true;
  server: string;
  tables: number;
  canViewDefinition: boolean;
  canWrite: boolean;
  hostKey?: string;
}

/** 測試連線：回報看得到多少資料表，以及帳號權限是否恰當。 */
export async function testConnection(
  input: CaptureInput,
): Promise<ConnectionReport> {
  const { value, hostKey } = await withSqlServer(
    input,
    async (query) =>
      (
        await query(
          "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) AS version, (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped=0) AS tables, HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION') AS can_view, CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UPDATE')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','DELETE')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER')=1 THEN 1 ELSE 0 END AS can_write",
        )
      )[0],
    30000,
    "capture",
  );
  return {
    ok: true,
    server: `SQL Server ${String(value.version ?? "")}`.trim(),
    tables: Number(value.tables),
    canViewDefinition: Number(value.can_view) === 1,
    canWrite: Number(value.can_write) === 1,
    ...(hostKey ? { hostKey } : {}),
  };
}

export async function captureSnapshot(input: CaptureInput) {
  const { value, hostKey } = await withSqlServer(
    input,
    (query) =>
      captureSqlServer(query, { referenceTables: input.referenceTables }),
    5 * 60 * 1000,
    "capture",
  );
  return { ...value, ...(hostKey ? { hostKey } : {}) };
}

/**
 * 定期檢查：在一定回滾的交易中執行單一唯讀 SELECT（另有唯讀連線意圖），
 * 最多回傳 100 列、每格 200 字。只在該檢查的專用檢查容器內執行（#19），
 * 經轉接器連線；工作容器拿不到連線資料。
 */
export async function runCheckQuery(
  input: CaptureInput,
  sql: string,
  via?: FirstHop,
) {
  const problem = assertReadOnlySelect(sql);
  if (problem) throw fail(problem);
  const { value } = await withSqlServer(
    input,
    async (query) => {
      await query(
        "SET NOCOUNT ON; SET LOCK_TIMEOUT 5000; BEGIN TRANSACTION",
        true,
      );
      try {
        return await query(sql);
      } finally {
        await query("IF @@TRANCOUNT>0 ROLLBACK TRANSACTION", true).catch(
          () => {},
        );
      }
    },
    30000,
    "check",
    via,
  );
  return value
    .slice(0, 100)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          typeof v === "string"
            ? v.slice(0, 200)
            : v instanceof Date
              ? v.toISOString()
              : v,
        ]),
      ),
    );
}
