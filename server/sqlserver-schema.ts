import { createHash } from "node:crypto";
import { AppError } from "./policy.js";

/**
 * 從 SQL Server 的系統目錄產生可重建結構的指令檔。
 * 只發出 SELECT；預設不讀任何資料列，參考資料表須由擁有者明確列出。
 */
export type Row = Record<string, unknown>;
export type Query = (sql: string) => Promise<Row[]>;

export interface SchemaCapture {
  files: Record<string, string>;
  objects: Record<string, number>;
  tables: string[];
  referenceRows: number;
  /** 沒有擷取到的項目，用白話告訴擁有者。 */
  warnings: string[];
  hash: string;
}

export const referenceRowLimit = 500;
const maxBytes = 20 * 1024 * 1024;

const id = (name: unknown) => `[${String(name).replaceAll("]", "]]")}]`;
const full = (schema: unknown, name: unknown) => `${id(schema)}.${id(name)}`;
const text = (value: unknown) => `N'${String(value).replaceAll("'", "''")}'`;
const flag = (value: unknown) => value === true || value === 1;

export function columnType(c: Row) {
  const name = String(c.type_name),
    length = Number(c.max_length),
    precision = Number(c.precision),
    scale = Number(c.scale);
  if (flag(c.is_user_defined)) return full(c.type_schema, name);
  switch (name) {
    case "varchar":
    case "char":
    case "varbinary":
    case "binary":
      return `${name}(${length === -1 ? "max" : length})`;
    case "nvarchar":
    case "nchar":
      return `${name}(${length === -1 ? "max" : length / 2})`;
    case "decimal":
    case "numeric":
      return `${name}(${precision},${scale})`;
    case "datetime2":
    case "datetimeoffset":
    case "time":
      return `${name}(${scale})`;
    case "float":
      return precision === 53 ? "float" : `float(${precision})`;
    default:
      return name;
  }
}

function columnLine(c: Row, withDefaults = true) {
  if (flag(c.is_computed))
    return `  ${id(c.col)} AS ${c.computed}${flag(c.is_persisted) ? " PERSISTED" : ""}`;
  const parts = [id(c.col), columnType(c)];
  if (flag(c.is_identity))
    parts.push(`IDENTITY(${c.seed ?? 1},${c.incr ?? 1})`);
  parts.push(flag(c.is_nullable) ? "NULL" : "NOT NULL");
  if (withDefaults && c.default_def)
    parts.push(`CONSTRAINT ${id(c.default_name)} DEFAULT ${c.default_def}`);
  return `  ${parts.join(" ")}`;
}

function groupBy(rows: Row[], key: (r: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return `'${value.toISOString().replace("Z", "")}'`;
  if (Buffer.isBuffer(value))
    return value.length ? `0x${value.toString("hex")}` : "0x";
  return text(value);
}

/** 參考資料表名稱只接受「資料表」或「結構描述.資料表」，並且必須真的存在。 */
export function resolveReferenceTables(requested: string[], tables: string[]) {
  const known = new Map(tables.map((t) => [t.toLowerCase(), t]));
  const found: string[] = [],
    missing: string[] = [];
  for (const raw of requested) {
    const name = raw.trim().replace(/[[\]]/g, "");
    if (!name) continue;
    const match =
      known.get(name.toLowerCase()) ?? known.get(`dbo.${name}`.toLowerCase());
    if (match) {
      if (!found.includes(match)) found.push(match);
    } else missing.push(raw.trim());
  }
  return { found, missing };
}

const sql = {
  schemas:
    "SELECT s.name FROM sys.schemas s WHERE s.schema_id BETWEEN 5 AND 16383 ORDER BY s.name",
  aliasTypes:
    "SELECT SCHEMA_NAME(t.schema_id) AS sch, t.name, bt.name AS type_name, CAST(0 AS bit) AS is_user_defined, t.max_length, t.precision, t.scale, t.is_nullable FROM sys.types t JOIN sys.types bt ON bt.user_type_id=t.system_type_id WHERE t.is_user_defined=1 AND t.is_table_type=0 AND t.is_assembly_type=0 ORDER BY sch, t.name",
  sequences:
    "SELECT SCHEMA_NAME(schema_id) AS sch, name, TYPE_NAME(user_type_id) AS type_name, CAST(start_value AS nvarchar(60)) AS start_value, CAST(increment AS nvarchar(60)) AS increment FROM sys.sequences ORDER BY sch, name",
  columns: (source: string, kind: string) =>
    `SELECT '${kind}' AS kind, SCHEMA_NAME(o.schema_id) AS sch, o.name AS tbl, c.column_id, c.name AS col, SCHEMA_NAME(ty.schema_id) AS type_schema, ty.name AS type_name, ty.is_user_defined, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, CAST(ic.seed_value AS nvarchar(40)) AS seed, CAST(ic.increment_value AS nvarchar(40)) AS incr, c.is_computed, cc.definition AS computed, cc.is_persisted, dc.definition AS default_def, dc.name AS default_name FROM ${source} JOIN sys.columns c ON c.object_id=o.target_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id ORDER BY sch, tbl, c.column_id`,
  tableSource:
    "(SELECT object_id AS target_id, schema_id, name FROM sys.tables WHERE is_ms_shipped=0) o",
  tableTypeSource:
    "(SELECT type_table_object_id AS target_id, schema_id, name FROM sys.table_types WHERE is_user_defined=1) o",
  indexes:
    "SELECT SCHEMA_NAME(o.schema_id) AS sch, o.name AS tbl, i.name AS idx, i.index_id, i.type AS index_type, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.filter_definition, ic.key_ordinal, ic.is_included_column, ic.is_descending_key, c.name AS col FROM sys.indexes i JOIN sys.tables o ON o.object_id=i.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE o.is_ms_shipped=0 AND i.type IN (1,2) AND i.is_hypothetical=0 AND i.is_disabled=0 ORDER BY sch, tbl, i.index_id, ic.key_ordinal, ic.index_column_id",
  checks:
    "SELECT SCHEMA_NAME(o.schema_id) AS sch, o.name AS tbl, k.name, k.definition FROM sys.check_constraints k JOIN sys.tables o ON o.object_id=k.parent_object_id WHERE o.is_ms_shipped=0 ORDER BY sch, tbl, k.name",
  foreignKeys:
    "SELECT fk.name, SCHEMA_NAME(pt.schema_id) AS sch, pt.name AS tbl, SCHEMA_NAME(rt.schema_id) AS ref_sch, rt.name AS ref_tbl, pc.name AS col, rc.name AS ref_col, fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.tables pt ON pt.object_id=fk.parent_object_id JOIN sys.tables rt ON rt.object_id=fk.referenced_object_id JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id WHERE fk.is_ms_shipped=0 ORDER BY sch, tbl, fk.name, fkc.constraint_column_id",
  synonyms:
    "SELECT SCHEMA_NAME(schema_id) AS sch, name, base_object_name FROM sys.synonyms ORDER BY sch, name",
  modules:
    "SELECT o.object_id, SCHEMA_NAME(o.schema_id) AS sch, o.name, RTRIM(o.type) AS type, m.definition, m.uses_ansi_nulls, m.uses_quoted_identifier FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0 AND o.type IN ('V','P','FN','IF','TF','TR') ORDER BY sch, o.name",
};

/**
 * 從定義內容找出模組之間的參考。不查 sys.sql_expression_dependencies：
 * 它需要額外的 SELECT 權限，只有 VIEW DEFINITION 的唯讀帳號讀不到。
 * 名稱比對可能多算，只會讓順序更保守，不影響產出的內容。
 */
function moduleReferences(modules: Row[]): Row[] {
  const names = modules.map((m) => ({
    id: Number(m.object_id),
    pattern: new RegExp(
      `(?<![\\w@#$])${String(m.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w@#$])`,
      "i",
    ),
  }));
  return modules.flatMap((m) =>
    names
      .filter(
        (n) =>
          n.id !== Number(m.object_id) && n.pattern.test(String(m.definition)),
      )
      .map((n) => ({ referencing_id: m.object_id, referenced_id: n.id })),
  );
}

const moduleRank: Record<string, number> = {
  FN: 0,
  IF: 0,
  TF: 0,
  V: 1,
  P: 2,
  TR: 3,
};

/** 先建立被參考的物件；有循環時維持類型與名稱順序。 */
function orderModules(modules: Row[], dependencies: Row[]) {
  const byId = new Map(modules.map((m) => [Number(m.object_id), m]));
  const needs = new Map<number, number[]>();
  for (const d of dependencies) {
    const from = Number(d.referencing_id),
      to = Number(d.referenced_id);
    if (byId.has(from) && byId.has(to))
      needs.set(from, [...(needs.get(from) ?? []), to]);
  }
  const sorted = [...modules].sort(
    (a, b) =>
      moduleRank[String(a.type)] - moduleRank[String(b.type)] ||
      `${a.sch}.${a.name}`.localeCompare(`${b.sch}.${b.name}`),
  );
  const done = new Set<number>(),
    visiting = new Set<number>(),
    ordered: Row[] = [];
  const visit = (m: Row) => {
    const key = Number(m.object_id);
    if (done.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const dep of needs.get(key) ?? []) visit(byId.get(dep)!);
    visiting.delete(key);
    done.add(key);
    ordered.push(m);
  };
  sorted.forEach(visit);
  return ordered;
}

export async function captureSqlServer(
  query: Query,
  options: { referenceTables?: string[] } = {},
): Promise<SchemaCapture> {
  const warnings: string[] = [];
  const batches: string[] = [];
  const add = (statement: string) => batches.push(statement);

  const schemas = await query(sql.schemas);
  for (const s of schemas)
    add(
      `IF SCHEMA_ID(${text(s.name)}) IS NULL EXEC(N'CREATE SCHEMA ${id(s.name).replaceAll("'", "''")}');`,
    );

  const aliasTypes = await query(sql.aliasTypes);
  for (const t of aliasTypes)
    add(
      `CREATE TYPE ${full(t.sch, t.name)} FROM ${columnType(t)} ${flag(t.is_nullable) ? "NULL" : "NOT NULL"};`,
    );

  const typeColumns = groupBy(
    await query(sql.columns(sql.tableTypeSource, "type")),
    (r) => `${r.sch}.${r.tbl}`,
  );
  for (const rows of typeColumns.values())
    add(
      `CREATE TYPE ${full(rows[0].sch, rows[0].tbl)} AS TABLE (\n${rows.map((c) => columnLine(c, false)).join(",\n")}\n);`,
    );

  const sequences = await query(sql.sequences);
  for (const s of sequences)
    add(
      `CREATE SEQUENCE ${full(s.sch, s.name)} AS ${s.type_name} START WITH ${s.start_value} INCREMENT BY ${s.increment};`,
    );

  const tableColumns = groupBy(
    await query(sql.columns(sql.tableSource, "table")),
    (r) => `${r.sch}.${r.tbl}`,
  );
  for (const rows of tableColumns.values())
    add(
      `CREATE TABLE ${full(rows[0].sch, rows[0].tbl)} (\n${rows.map((c) => columnLine(c)).join(",\n")}\n);`,
    );
  const tables = [...tableColumns.keys()];

  const indexes = groupBy(
    await query(sql.indexes),
    (r) => `${r.sch}.${r.tbl}.${r.index_id}`,
  );
  for (const rows of indexes.values()) {
    const first = rows[0],
      table = full(first.sch, first.tbl),
      clustered = Number(first.index_type) === 1 ? "CLUSTERED" : "NONCLUSTERED";
    const keys = rows
      .filter((r) => !flag(r.is_included_column))
      .map((r) => `${id(r.col)}${flag(r.is_descending_key) ? " DESC" : ""}`)
      .join(", ");
    const included = rows
      .filter((r) => flag(r.is_included_column))
      .map((r) => id(r.col))
      .join(", ");
    if (flag(first.is_primary_key) || flag(first.is_unique_constraint))
      add(
        `ALTER TABLE ${table} ADD CONSTRAINT ${id(first.idx)} ${flag(first.is_primary_key) ? "PRIMARY KEY" : "UNIQUE"} ${clustered} (${keys});`,
      );
    else
      add(
        `CREATE ${flag(first.is_unique) ? "UNIQUE " : ""}${clustered} INDEX ${id(first.idx)} ON ${table} (${keys})${included ? ` INCLUDE (${included})` : ""}${first.filter_definition ? ` WHERE ${first.filter_definition}` : ""};`,
      );
  }

  const checks = await query(sql.checks);
  for (const k of checks)
    add(
      `ALTER TABLE ${full(k.sch, k.tbl)} WITH NOCHECK ADD CONSTRAINT ${id(k.name)} CHECK ${k.definition};`,
    );

  const synonyms = await query(sql.synonyms);
  for (const s of synonyms)
    add(`CREATE SYNONYM ${full(s.sch, s.name)} FOR ${s.base_object_name};`);

  const modules = await query(sql.modules);
  const readable = modules.filter((m) => typeof m.definition === "string");
  const hidden = modules.length - readable.length;
  if (hidden)
    warnings.push(
      `有 ${hidden} 個檢視、預存程序或函式的內容讀不到（已加密，或帳號沒有 VIEW DEFINITION 權限），快照不包含它們。`,
    );
  for (const m of orderModules(readable, moduleReferences(readable)))
    add(
      `SET ANSI_NULLS ${flag(m.uses_ansi_nulls) ? "ON" : "OFF"};\nSET QUOTED_IDENTIFIER ${flag(m.uses_quoted_identifier) ? "ON" : "OFF"};\nGO\n${String(m.definition).trim()}`,
    );

  const foreignKeys = groupBy(
    await query(sql.foreignKeys),
    (r) => `${r.sch}.${r.tbl}.${r.name}`,
  );
  const fkBatches = [...foreignKeys.values()].map((rows) => {
    const f = rows[0];
    const action = (kind: string, value: unknown) =>
      value && value !== "NO_ACTION"
        ? ` ON ${kind} ${String(value).replaceAll("_", " ")}`
        : "";
    return `ALTER TABLE ${full(f.sch, f.tbl)} WITH NOCHECK ADD CONSTRAINT ${id(f.name)} FOREIGN KEY (${rows.map((r) => id(r.col)).join(", ")}) REFERENCES ${full(f.ref_sch, f.ref_tbl)} (${rows.map((r) => id(r.ref_col)).join(", ")})${action("DELETE", f.on_delete)}${action("UPDATE", f.on_update)};`;
  });

  const reference = resolveReferenceTables(
    options.referenceTables ?? [],
    tables,
  );
  if (reference.missing.length)
    warnings.push(
      `找不到這些參考資料表，已略過：${reference.missing.slice(0, 10).join("、")}`,
    );
  const dataBatches: string[] = [];
  let referenceRows = 0;
  for (const table of reference.found) {
    const columns = tableColumns
      .get(table)!
      .filter(
        (c) =>
          !flag(c.is_computed) &&
          !["timestamp", "rowversion"].includes(String(c.type_name)),
      );
    const target = full(columns[0].sch, columns[0].tbl);
    const names = columns.map((c) => id(c.col)).join(", ");
    let rows: Row[];
    try {
      rows = await query(
        `SELECT TOP (${referenceRowLimit}) ${names} FROM ${target}`,
      );
    } catch {
      warnings.push(
        `讀不到參考資料表 ${table}（帳號可能沒有 SELECT 權限），已略過。`,
      );
      continue;
    }
    if (!rows.length) continue;
    referenceRows += rows.length;
    const identity = columns.some((c) => flag(c.is_identity));
    dataBatches.push(
      [
        ...(identity ? [`SET IDENTITY_INSERT ${target} ON;`] : []),
        ...rows.map(
          (row) =>
            `INSERT INTO ${target} (${names}) VALUES (${columns.map((c) => literal(row[String(c.col)])).join(", ")});`,
        ),
        ...(identity ? [`SET IDENTITY_INSERT ${target} OFF;`] : []),
      ].join("\n"),
    );
  }

  // sqlcmd 預設關閉 QUOTED_IDENTIFIER；篩選索引、計算欄位與索引檢視都需要開啟。
  const session =
    "SET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\nSET ANSI_PADDING ON;\nSET ANSI_WARNINGS ON;\nSET ARITHABORT ON;\nSET CONCAT_NULL_YIELDS_NULL ON;\nSET NUMERIC_ROUNDABORT OFF;";
  const join = (items: string[]) =>
    items.length ? `${[session, ...items].join("\nGO\n")}\nGO\n` : "";
  const files: Record<string, string> = {
    "schema.sql": join(batches),
    "foreign-keys.sql": join(fkBatches),
  };
  if (dataBatches.length) files["reference-data.sql"] = join(dataBatches);
  files["README.md"] = [
    "# 資料庫結構快照（SQL Server）",
    "",
    "由擁有者登記的資料庫擷取，只含結構；`reference-data.sql` 是擁有者明確指定的參考資料表。這個目錄唯讀。",
    "",
    "套用順序（在容器內啟動的本機 SQL Server、空白資料庫上執行）：",
    "",
    "1. `schema.sql`：結構描述、型別、資料表、索引、檢查條件、檢視、函式、預存程序、觸發程序。",
    "2. `reference-data.sql`（有才套用）。",
    "3. `foreign-keys.sql`（選用；產生虛構資料前先不套用比較容易）。",
    "",
    '範例：`/opt/mssql-tools18/bin/sqlcmd -C -S 127.0.0.1 -U sa -P "$MSSQL_SA_PASSWORD" -d 測試資料庫 -i schema.sql`',
    "",
    "用 sqlcmd 執行時不要加 `-b`：個別物件失敗時繼續套用其餘批次，再依錯誤訊息判斷是否影響測試。",
    "快照不含定序、檔案群組、分割、全文檢索、CLR 物件與資料庫層級設定。",
    "",
  ].join("\n");
  if (
    Object.values(files).reduce((n, f) => n + Buffer.byteLength(f), 0) >
    maxBytes
  )
    throw new AppError(422, "結構快照超過 20 MB，請減少參考資料表");

  const count = (type: string[]) =>
    readable.filter((m) => type.includes(String(m.type))).length;
  return {
    files,
    tables,
    referenceRows,
    warnings,
    objects: {
      schemas: schemas.length,
      tables: tables.length,
      indexes: indexes.size,
      foreignKeys: foreignKeys.size,
      views: count(["V"]),
      procedures: count(["P"]),
      functions: count(["FN", "IF", "TF"]),
      triggers: count(["TR"]),
      types: aliasTypes.length + typeColumns.size,
      sequences: sequences.length,
      synonyms: synonyms.length,
    },
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
