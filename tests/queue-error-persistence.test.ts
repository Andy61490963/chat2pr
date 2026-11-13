import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { db, fixture, reset, confirmTask } from "./helpers.js";
import { startJobs } from "../server/jobs.js";
import { GitHub } from "../server/github.js";

beforeEach(async () => {
  await reset();
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
  );
});
afterAll(() => db.close());

it("真實 issues 佇列只保存安全錯誤，供應商恢復後仍可建立 Issue", async () => {
  const project = await fixture(),
    task = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,dedupe_key) VALUES($1,'group-a','佇列錯誤測試','保留診斷','[]','awaiting_approval','safe-queue') RETURNING id",
      [project],
    );
  const marker = "完全沒有金鑰前綴的虛構敏感內容";
  await confirmTask(task.id);
  await db.query("UPDATE tasks SET status='queued',approved_version=version WHERE id=$1", [task.id]);
  const github = new GitHub();
  github.ensureIssue = vi.fn(async () => {
    throw Object.assign(new Error(marker), {
      name: "HttpError",
      status: 401,
      request: { headers: { authorization: marker } },
      response: { data: { message: marker } },
      cause: new Error(marker),
    });
  });
  vi.stubEnv("DATABASE_URL", db.pool.options.connectionString!);
  let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
  try {
    jobs = await startJobs(db, {
      github,
      runner: {
        async call() {
          throw new Error("佇列錯誤測試不得啟動開發容器");
        },
        async upload() {},
      },
    });
    const wait = async (id: string, expected: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const row = await db.one<{
          state: string;
          output: Record<string, unknown>;
        }>("SELECT state,output FROM pgboss.job WHERE id=$1", [id]);
        if (row?.state === expected) return row;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("佇列未在期限內完成預期狀態");
    };
    // 此回歸聚焦持久化欄位；三次重試由獨立故障矩陣驗證。
    const id = await jobs.boss.send(
      "issues",
      { taskId: task.id },
      { retryLimit: 0 },
    );
    const failed = await wait(id!, "failed");
    expect(failed.output.message).toContain("HTTP 401");
    expect(JSON.stringify(failed.output)).not.toContain(marker);
    expect(Object.keys(failed.output).sort()).toEqual([
      "message",
      "name",
      "stack",
    ]);
    expect(
      (await db.one("SELECT issue_number FROM tasks WHERE id=$1", [task.id]))
        .issue_number,
    ).toBeNull();
    github.ensureIssue = vi.fn(async () => ({
      number: 7,
      url: "https://example.invalid/issues/7",
    }));
    const resumed = await jobs.boss.send(
      "issues",
      { taskId: task.id },
      { retryLimit: 0 },
    );
    await wait(resumed!, "completed");
    expect(
      (await db.one("SELECT issue_number FROM tasks WHERE id=$1", [task.id]))
        .issue_number,
    ).toBe(7);
    expect(github.ensureIssue).toHaveBeenCalledTimes(1);
  } finally {
    await jobs?.stop();
    vi.unstubAllEnvs();
  }
}, 30000);
