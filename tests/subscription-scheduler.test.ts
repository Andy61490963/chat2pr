import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { db, fixture, reset } from "./helpers.js";
import { startJobs } from "../server/jobs.js";
import { GitHub } from "../server/github.js";
import type { Runner } from "../server/execution.js";
import type { SubscriptionAccount } from "../server/subscription-gate.js";

beforeEach(async () => {
  await reset();
  await db.query(
    "DELETE FROM service_health WHERE name='codex_subscription_gate'",
  );
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  await db.query(
    `UPDATE settings SET value=jsonb_set(value,'{ai_mode}','"subscription"')`,
  );
});
afterAll(() => db.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["mode", false],
  ["limit", false],
  ["pause", false],
  ["mode", true],
  ["limit", true],
  ["pause", true],
] as const)(
  "排程額度讀取途中變更 %s，allowed=%s 不得套用舊設定轉移任務",
  async (change, allowed) => {
    const project = await fixture();
    const before = allowed ? "budget_wait" : "queued";
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) VALUES($1,'group-a','設定競態測試','保持任務狀態','[]',$2,1,'settings-race') RETURNING id",
      [project, before],
    );
    const entered = deferred<void>(),
      pending = deferred<SubscriptionAccount>();
    const call = vi.fn(async (path: string): Promise<any> => {
      // 每分鐘核對定期檢查環境（#19）不是模型執行，不在這個測試的範圍。
      if (path.startsWith("checks/environments")) return { removed: [] };
      throw new Error("設定變更期間不可執行模型");
    });
    const runner: Runner = {
      async account() {
        entered.resolve();
        return pending.promise;
      },
      async upload() {},
      call,
    };
    const github = new GitHub();
    github.ensureIssue = async () => ({
      number: 1,
      url: "https://example.invalid/1",
    });
    let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
    vi.stubEnv("DATABASE_URL", db.pool.options.connectionString!);
    try {
      const starting = startJobs(db, { runner, github });
      await entered.promise;
      const replacement =
        change === "mode"
          ? { ai_mode: "api" }
          : change === "limit"
            ? { daily_runs: 0 }
            : { paused: true };
      await db.query("UPDATE settings SET value=value||$1::jsonb", [
        JSON.stringify(replacement),
      ]);
      pending.resolve({ allowed, checkedAt: new Date().toISOString() });
      jobs = await starting;
      expect(
        (
          await db.one<{ status: string }>(
            "SELECT status FROM tasks WHERE id=$1",
            [task.id],
          )
        ).status,
      ).toBe(before);
      expect(
        call.mock.calls.filter(
          ([path]) => !String(path).startsWith("checks/environments"),
        ),
      ).toEqual([]);
      expect(
        (await db.settings())[
          change === "mode"
            ? "ai_mode"
            : change === "limit"
              ? "daily_runs"
              : "paused"
        ],
      ).toBe(change === "mode" ? "api" : change === "limit" ? 0 : true);
    } finally {
      await jobs?.stop();
      vi.unstubAllEnvs();
    }
  },
);
