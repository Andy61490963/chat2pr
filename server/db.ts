import pg from "pg";
import { readFile } from "node:fs/promises";
import type { Settings } from "../shared/types.js";
export type DbClient = Pick<pg.PoolClient, "query">;
export class Database {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
  }
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }
  async one<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.pool.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  }
  async settings(): Promise<Settings> {
    const stored = (
      await this.one<{ value: Settings }>(
        "SELECT value FROM settings WHERE id=1",
      )
    ).value;
    return {
      ...stored,
      triage_paused: stored.triage_paused ?? false,
      auto_memory: stored.auto_memory ?? true,
      code_downloads: stored.code_downloads ?? true,
      group_replies: stored.group_replies ?? true,
      container_network: stored.container_network ?? "isolated",
    };
  }
  async audit(
    taskId: string | null,
    kind: string,
    detail: string,
    client: DbClient = this.pool,
  ) {
    await client.query(
      "INSERT INTO audit(task_id,kind,detail) VALUES($1,$2,$3)",
      [taskId, kind, detail],
    );
  }
  close() {
    return this.pool.end();
  }
}
