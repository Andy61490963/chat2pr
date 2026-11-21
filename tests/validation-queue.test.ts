import type { JobWithMetadata, SendOptions } from "pg-boss";
import { expect, it, vi } from "vitest";
import type { Project } from "../shared/types.js";
import { Budget } from "../server/budget.js";
import type { Database, DbClient } from "../server/db.js";
import { Execution, HttpRunner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { AppError } from "../server/policy.js";
import {
  ValidationQueue,
  type ValidationJob,
} from "../server/validation-queue.js";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  config_version: 2,
  name: "範例訂單",
  description: "虛構的訂單專案",
  repo: "fictional/orders",
  base_branch: "main",
  image: "fictional-worker:local",
  install_command: "npm ci",
  test_command: "npm test",
  setup_mode: "manual",
  sensitive_paths: [],
  enabled: false,
  validation_error: null,
  validated_at: null,
  created_at: "2026-01-01T00:00:00Z",
};
const jobId = "22222222-2222-4222-8222-222222222222";
const job = {
  id: jobId,
  data: { id: project.id, version: project.config_version },
  retryCount: 0,
  retryLimit: 2,
} as JobWithMetadata<ValidationJob>;

function scenario() {
  const active = { pending: false };
  const transactionQuery = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT config_version")) return { rows: [project] };
    if (sql.includes("UPDATE projects SET validated_at=now()"))
      return { rows: [project], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM pgboss.job"))
      return { rowCount: active.pending ? 1 : 0 };
    return { rowCount: 1 };
  });
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
  const lock = {
    query: vi.fn(async () => ({ rows: [{ locked: true }] })),
    release: vi.fn(),
  };
  const db = {
    one: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM projects")) return project;
      if (sql.startsWith("SELECT 1 FROM projects")) return { current: true };
      if (sql.includes("FROM repo_indexes")) return { indexed: true };
      return undefined;
    }),
    query,
    transaction: async (fn: (c: DbClient) => Promise<unknown>) =>
      fn({ query: transactionQuery } as unknown as DbClient),
    settings: async () => ({}),
    pool: { connect: async () => lock },
  } as unknown as Database;
  const send = vi.fn(
    async (_queue: string, _data: ValidationJob, _options?: SendOptions) => {
      active.pending = true;
      return jobId;
    },
  );
  const complete = vi.fn(async () => ({}));
  const runner = new HttpRunner();
  const prepare = vi
    .spyOn(runner, "prepareSource")
    .mockResolvedValue({} as never);
  const phase = vi.spyOn(runner, "call").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  const github = new GitHub();
  vi.spyOn(github, "base").mockResolvedValue("fictional-sha");
  vi.spyOn(github, "sourceAccess").mockResolvedValue({} as never);
  const execution = new Execution(
    db,
    github,
    new Line(db),
    new Budget(db),
    runner,
  );
  return {
    active,
    send,
    complete,
    prepare,
    phase,
    query,
    transactionQuery,
    lock,
    execution,
    queue: new ValidationQueue(db, { send, complete }),
    errors: () =>
      query.mock.calls
        .filter(([sql]) => sql.includes("validation_error=$2"))
        .map(([, params]) => params?.[1]),
  };
}

it("測試指令固定失敗時只執行一輪並留下原因", async () => {
  const s = scenario();
  s.phase
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
    .mockResolvedValueOnce({
      exitCode: 127,
      stdout: "",
      stderr: "example-test: command not found",
    });
  await expect(s.queue.work(job, s.execution)).resolves.toBeUndefined();
  expect(s.prepare).toHaveBeenCalledTimes(1);
  expect(s.phase.mock.calls.filter(([path]) => path === "phase")).toHaveLength(
    2,
  );
  expect(
    s.query.mock.calls
      .filter(([sql]) => sql.includes("UPDATE pgboss.job"))
      .map(([, values]) => values?.[2]),
  ).toEqual([
    "你的專案正在等待執行器。",
    "你的專案正在等待執行器準備隔離環境。",
    "你的專案正在安裝相依套件。",
    "你的專案正在執行基底測試。",
  ]);
  expect(s.errors()).toEqual([expect.stringContaining("command not found")]);
  expect(s.send).not.toHaveBeenCalled();
});

it("執行器連線暫時中斷時交回佇列重試，下一輪確實重新驗證", async () => {
  const s = scenario();
  s.prepare.mockRejectedValueOnce(new Error("執行器連線失敗（ETIMEDOUT）"));
  await expect(s.queue.work(job, s.execution)).rejects.toThrow("ETIMEDOUT");
  expect(s.errors()).toEqual([expect.stringContaining("ETIMEDOUT")]);
  await expect(
    s.queue.work({ ...job, retryCount: 1 }, s.execution),
  ).resolves.toBeUndefined();
  expect(s.prepare).toHaveBeenCalledTimes(2);
  expect(s.transactionQuery).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE projects SET validated_at=now()"),
    expect.arrayContaining([project.id, project.config_version]),
  );
  expect(s.errors()).toHaveLength(1);
  expect(s.send).not.toHaveBeenCalled();
});

it("缺少 GitHub App 設定時，即使回傳 503 也會結束驗證", async () => {
  const s = scenario();
  s.prepare.mockRejectedValueOnce(new AppError(503, "GitHub App 尚未完成設定"));
  await expect(s.queue.work(job, s.execution)).resolves.toBeUndefined();
  expect(s.errors()).toEqual(["GitHub App 尚未完成設定"]);
});

it("暫時查不到訂閱額度時交由佇列重試", async () => {
  const s = scenario();
  s.prepare.mockRejectedValueOnce(new AppError(429, "無法確認 Codex 訂閱額度"));
  await expect(s.queue.work(job, s.execution)).rejects.toThrow(
    "無法確認 Codex 訂閱額度",
  );
});

it("同一專案重複驗證時，只在交易內排入一個工作", async () => {
  const s = scenario();
  await expect(s.queue.enqueue(project.id)).resolves.toBe(true);
  await expect(s.queue.enqueue(project.id)).resolves.toBe(false);
  expect(s.send).toHaveBeenCalledExactlyOnceWith("validate", job.data, {
    db: { executeSql: expect.any(Function) },
  });
});

it("等舊驗證釋放鎖時保存等待原因與剩餘重試次數", async () => {
  const s = scenario();
  s.active.pending = true;
  s.lock.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
  const retry = { ...job, retryCount: 1 };
  await s.queue.work(retry, s.execution);
  expect(s.send).toHaveBeenCalledExactlyOnceWith(
    "validate",
    { ...job.data, progress: "你的專案正在等待上一次驗證釋放執行環境。" },
    { startAfter: 30, retryLimit: 1, db: { executeSql: expect.any(Function) } },
  );
  expect(s.complete).toHaveBeenCalledExactlyOnceWith("validate", retry, null, {
    db: s.send.mock.calls[0][2]?.db,
  });
  expect(s.prepare).not.toHaveBeenCalled();
});

it("設定升版後，舊版工作不會啟動驗證", async () => {
  const s = scenario();
  await s.queue.work(
    { ...job, data: { ...job.data, version: 1 } },
    s.execution,
  );
  expect(s.lock.query).not.toHaveBeenCalled();
  expect(s.prepare).not.toHaveBeenCalled();
});
