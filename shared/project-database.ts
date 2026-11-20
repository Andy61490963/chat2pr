/** 看板可見的資料庫連線資訊；密碼與私鑰只寫入，永遠不回傳。 */
export interface DatabaseConnectionView {
  engine: "sqlserver";
  host: string;
  port: number;
  database: string;
  username: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  referenceTables: string[];
  ssh: {
    host: string;
    port: number;
    username: string;
    auth: "key" | "password";
    /** 第一次連線成功時記下的主機金鑰指紋。 */
    hostKey: string | null;
  } | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SchemaSnapshotView {
  version: number;
  engine: "sqlserver";
  hash: string;
  objects: Record<string, number>;
  referenceRows: number;
  warnings: string[];
  bytes: number;
  capturedAt: string;
  capturedBy: string | null;
}

export interface ProjectDatabaseView {
  connection: DatabaseConnectionView | null;
  snapshot: SchemaSnapshotView | null;
}

export interface ConnectionTestResult {
  ok: true;
  server: string;
  tables: number;
  canViewDefinition: boolean;
  canWrite: boolean;
}

/** 提供給環境規劃與工作容器的快照摘要；內容檔案另外以唯讀資料卷掛載。 */
export interface SnapshotSummary {
  engine: "sqlserver";
  version: number;
  hash: string;
  directory: string;
  files: string[];
  objects: Record<string, number>;
  tables: string[];
}

export const snapshotDirectory = "/agentflow/env/database";

export const objectLabels: Record<string, string> = {
  tables: "資料表",
  views: "檢視",
  procedures: "預存程序",
  functions: "函式",
  triggers: "觸發程序",
  indexes: "索引",
  foreignKeys: "外鍵",
  types: "自訂型別",
  sequences: "序列",
  synonyms: "同義字",
  schemas: "結構描述",
};

/** 「用白話描述連線」交給 AI 整理後的結果；看板用來填表，不會自動儲存。 */
export interface ConnectionExtractResult {
  connection: {
    host: string | null;
    port: number | null;
    database: string | null;
    username: string | null;
    password: string | null;
    encrypt: boolean | null;
    trustServerCertificate: boolean | null;
    ssh: {
      host: string;
      port: number | null;
      username: string | null;
      password: string | null;
    } | null;
  };
  /** 描述中提到、需要連得到的位址，以及從這台伺服器實測的結果。 */
  endpoints: {
    host: string;
    port: number;
    purpose: string;
    reachable: boolean;
    detail: string;
  }[];
  vpn: { needed: boolean; note: string };
  notes: string[];
}
