import { PgBoss, type JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { db, fixture, reset } from "./helpers.js";
import {
  ValidationQueue,
  type ValidationJob,
} from "../server/validation-queue.js";

// 用真的 pg-boss 與資料表核對 ValidationQueue 的 SQL：去重、進度、等鎖交接。
let boss: PgBoss;
beforeEach(async () => {
  await reset();
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  boss = new PgBoss(db.pool.options.connectionString!);
  await boss.start();
  await boss.createQueue("validate", {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 2400,
  });
});
afterEach(() => boss.stop({ graceful: false }));
afterAll(() => db.close());

const live = (id: string) =>
  db.query<{ state: string; progress: string | null; version: string }>(
    "SELECT state,data->>'progress' AS progress,data->>'version' AS version FROM pgboss.job WHERE name='validate' AND data->>'id'=$1 AND state IN ('created','retry','active') ORDER BY created_on",
    [id],
  );

it("同一版設定重複按驗證只排一次，改版後可以再排", async () => {
  const id = await fixture();
  const queue = new ValidationQueue(db, boss);
  expect(await queue.enqueue(id)).toBe(true);
  expect(await queue.enqueue(id)).toBe(false);
  expect(await live(id)).toHaveLength(1);
  expect(await queue.progress()).toEqual([
    { id, version: 1, progress: "你的專案正在排隊等待執行器。" },
  ]);

  await db.query("UPDATE projects SET config_version=2 WHERE id=$1", [id]);
  expect(await queue.enqueue(id)).toBe(true);
  expect((await live(id)).map((j) => j.version)).toEqual(["1", "2"]);
  expect(await queue.progress()).toEqual([
    { id, version: 2, progress: "你的專案正在排隊等待執行器。" },
  ]);
});

it("執行中的驗證回報階段；搶不到鎖時在同一交易交接成新的等待工作", async () => {
  const id = await fixture();
  const queue = new ValidationQueue(db, boss);
  await queue.enqueue(id);
  const [job] = (await boss.fetch("validate", {
    includeMetadata: true,
  })) as JobWithMetadata<ValidationJob>[];
  expect(job).toBeDefined();

  await queue.work(job!, {
    validate: async (_project, report) => {
      await report?.("你的專案正在安裝相依套件。");
      expect(await queue.progress()).toEqual([
        { id, version: 1, progress: "你的專案正在安裝相依套件。" },
      ]);
      // 鎖被舊驗證占用時 validate 回傳 ok=false 且不是等待補問。
      return { ok: false };
    },
  });

  const rows = await live(id);
  expect(rows).toEqual([
    {
      state: "created",
      progress: "你的專案正在等待上一次驗證釋放執行環境。",
      version: "1",
    },
  ]);
  const old = await db.one<{ state: string }>(
    "SELECT state FROM pgboss.job WHERE id=$1",
    [job!.id],
  );
  expect(old?.state).toBe("completed");
  // 等鎖期間再按驗證仍視為已在驗證中。
  expect(await queue.enqueue(id)).toBe(false);
});

it("確定性失敗只跑一輪就結束，暫時性失敗交給佇列重試", async () => {
  const id = await fixture();
  const queue = new ValidationQueue(db, boss);
  await queue.enqueue(id);
  const [job] = (await boss.fetch("validate", {
    includeMetadata: true,
  })) as JobWithMetadata<ValidationJob>[];
  let calls = 0;
  await queue.work(job!, {
    validate: async () => {
      calls++;
      throw new Error("找不到測試指令 npm test");
    },
  });
  expect(calls).toBe(1);

  const transient = Object.assign(new Error("connect ETIMEDOUT"), {
    name: "TimeoutError",
  });
  await expect(
    queue.work(job!, {
      validate: async () => {
        throw transient;
      },
    }),
  ).rejects.toBe(transient);
});
