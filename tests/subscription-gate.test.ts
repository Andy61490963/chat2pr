import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { db, fixture, reset, confirmTask } from "./helpers.js";
import { Database } from "../server/db.js";
import {
  SubscriptionGate,
  subscriptionGateName,
} from "../server/subscription-gate.js";
import { ModeClassifier, type Classifier } from "../server/triage.js";
import { AppError } from "../server/policy.js";
import { Execution, HttpRunner, type Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import type { Task } from "../shared/types.js";
import { Tasks } from "../server/tasks.js";

beforeEach(async () => {
  await reset();
  await db.query("DELETE FROM service_health WHERE name=$1", [
    subscriptionGateName,
  ]);
});
afterAll(() => db.close());
const account = (allowed: boolean | null) => ({
  allowed,
  checkedAt: new Date().toISOString(),
});
const subscription = () =>
  db.query(
    `UPDATE settings SET value=jsonb_set(value,'{ai_mode}','"subscription"')`,
  );
const expire = () =>
  db.query(
    "UPDATE service_health SET checked_at=now()-interval '61 seconds' WHERE name=$1",
    [subscriptionGateName],
  );

it("allowed=false 跨服務物件保留阻擋，快取期間不重讀也不放行", async () => {
  const read = vi.fn(async () => account(false));
  await expect(new SubscriptionGate(db, read).ensure()).rejects.toThrow(
    "額度已達上限",
  );
  const reopened = new Database(db.pool.options.connectionString!);
  try {
    await expect(new SubscriptionGate(reopened, read).ensure()).rejects.toThrow(
      "額度已達上限",
    );
  } finally {
    await reopened.close();
  }
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(["未知", "離線", "過期"])(
  "%s額度不得視為充足，等待期間不重試讀取",
  async (kind) => {
    const read = vi.fn(async () => {
      if (kind === "離線") throw new Error("network failed");
      return kind === "未知"
        ? account(null)
        : { allowed: true, checkedAt: "2020-01-01T00:00:00Z" };
    });
    const gate = new SubscriptionGate(db, read);
    await expect(gate.ensure()).rejects.toThrow("無法確認");
    await expect(gate.ensure()).rejects.toThrow("無法確認");
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it("並行檢查只讀一次；首次 quota 立即覆寫正向快取，恢復須重新確認 allowed=true", async () => {
  const read = vi.fn(async () => account(true));
  const gate = new SubscriptionGate(db, read);
  await Promise.all(Array.from({ length: 4 }, () => gate.ensure()));
  expect(read).toHaveBeenCalledTimes(1);
  await gate.exhausted();
  await expect(new SubscriptionGate(db, read).ensure()).rejects.toThrow(
    "額度已達上限",
  );
  expect(read).toHaveBeenCalledTimes(1);
  await expire();
  await gate.ensure();
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    (
      await db.one("SELECT ok FROM service_health WHERE name=$1", [
        subscriptionGateName,
      ])
    ).ok,
  ).toBe(true);
});

it("正向額度快取最多 30 秒；下次讀到 false 就停止", async () => {
  const read = vi.fn(async () => account(true));
  const gate = new SubscriptionGate(db, read);
  await gate.ensure();
  await db.query(
    "UPDATE service_health SET checked_at=now()-interval '31 seconds' WHERE name=$1",
    [subscriptionGateName],
  );
  read.mockImplementation(async () => account(false));
  await expect(gate.ensure()).rejects.toThrow("額度已達上限");
  expect(read).toHaveBeenCalledTimes(2);
});

const input: Parameters<Classifier["classify"]>[0] = {
  messages: [],
  context: {},
  tasks: [],
  model: "test",
  reservation: null,
};
it.each(["text", "image"] as const)(
  "%s 判讀入口在額度不足時零 AI，也不轉用 API",
  async (type) => {
    await subscription();
    await fixture();
    const message = await db.one<
      Parameters<Classifier["classify"]>[0]["messages"][number]
    >(
      "INSERT INTO messages(id,group_id,type,text) VALUES('quota-input','group-a',$1,$2) RETURNING *",
      [type, type === "text" ? "請調整按鈕顏色" : null],
    );
    const read = vi.fn(async () => account(false));
    const api = { classify: vi.fn(async () => []) },
      codex = { classify: vi.fn(async () => []) };
    const mode = new ModeClassifier(
      db,
      api,
      codex,
      new SubscriptionGate(db, read),
    );
    await expect(
      mode.classify({ ...input, messages: [message] }),
    ).rejects.toThrow("額度已達上限");
    expect(api.classify).not.toHaveBeenCalled();
    expect(codex.classify).not.toHaveBeenCalled();
  },
);

it("隔離執行器額度檢查沿用注入的 runner key，不誤用正式連線憑證", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(account(true)),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    await new HttpRunner(() => "isolated-runner-only").account();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-runner-key": "isolated-runner-only" },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("第一個判讀回報 quota 後，其他群組判讀入口使用持久化阻擋", async () => {
  await subscription();
  const api = { classify: vi.fn(async () => []) },
    codex = {
      classify: vi.fn(async () => {
        throw new AppError(429, "訂閱 quota");
      }),
    };
  const read = vi.fn(async () => account(true));
  const mode = () =>
    new ModeClassifier(db, api, codex, new SubscriptionGate(db, read));
  await expect(mode().classify(input)).rejects.toThrow("quota");
  await expect(mode().classify(input)).rejects.toThrow("額度已達上限");
  expect(codex.classify).toHaveBeenCalledTimes(1);
  expect(api.classify).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it("API 模式不讀取訂閱額度或誤改模式", async () => {
  const read = vi.fn(async () => account(false)),
    api = { classify: vi.fn(async () => []) },
    codex = { classify: vi.fn(async () => []) };
  await new ModeClassifier(
    db,
    api,
    codex,
    new SubscriptionGate(db, read),
  ).classify(input);
  expect(api.classify).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  expect((await db.settings()).ai_mode).toBe("api");
});

async function scenario(when: "blocked" | "quota" | "repair" | "review") {
  await subscription();
  const projectId = await fixture();
  const task = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) VALUES($1,'group-a','測試額度阻擋','調整按鈕文字','[\"文字符合\"]','queued',1,'quota-test') RETURNING *",
    [projectId],
  );
  const github = new GitHub();
  await confirmTask(task.id);
  github.base = async () => "base";
  github.archive = async () => new Blob(["fixture"]).stream();
  github.findPr = async () => undefined!;
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://example.invalid/1",
  });
  github.publish = vi.fn();
  const calls: string[] = [];
  const runner: Runner = {
    account: async () => account(when !== "blocked"),
    async upload() {},
    async call<T>(path: string, raw: unknown): Promise<T> {
      const { phase } = raw as { phase?: string };
      let result = { exitCode: 0, stdout: "", stderr: "" };
      if (path === "phase") {
        calls.push(phase!);
        if (phase === "code" && when === "quota")
          result = { exitCode: 1, stdout: "", stderr: "usage limit reached" };
        if (phase === "collect")
          result.stdout = JSON.stringify({
            files: [{ path: "src/button.ts", content: "YQ==", mode: "100644" }],
          });
        if (phase === "test" && ["repair", "review"].includes(when)) {
          await new SubscriptionGate(db).exhausted();
          if (when === "repair") result.exitCode = 1;
        }
      }
      return result as T;
    },
  };
  return {
    task,
    calls,
    github,
    runner,
    execution: new Execution(db, github, new Line(db), new Budget(db), runner),
  };
}

it.each(["blocked", "quota", "repair", "review"] as const)(
  "開發入口 %s 保留 budget_wait 並阻止後續 AI",
  async (kind) => {
    const s = await scenario(kind);
    await s.execution.execute(s.task.id);
    expect(
      (await db.one("SELECT status FROM tasks WHERE id=$1", [s.task.id]))
        .status,
    ).toBe("budget_wait");
    expect(s.calls.filter((x) => x === "code")).toHaveLength(
      kind === "blocked" ? 0 : 1,
    );
    expect(s.calls).not.toContain("review");
    expect(s.github.publish).not.toHaveBeenCalled();
    expect((await db.settings()).paused).toBe(false);
    expect((await db.settings()).ai_mode).toBe("subscription");
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["pause", false],
  ["mode", false],
  ["limit", false],
  ["pause", true],
  ["mode", true],
  ["limit", true],
] as const)(
  "開發起始額度讀取期間變更 %s，allowed=%s 不得套用舊設定開始工作",
  async (change, allowed) => {
    const s = await scenario("quota"),
      entered = deferred<void>(),
      pending = deferred<ReturnType<typeof account>>();
    s.runner.account = async () => {
      entered.resolve();
      return pending.promise;
    };
    const execution = new Execution(
      db,
      s.github,
      new Line(db),
      new Budget(db),
      s.runner,
    );
    const running = execution.execute(s.task.id);
    await entered.promise;
    const replacement =
      change === "pause"
        ? { paused: true }
        : change === "mode"
          ? { ai_mode: "api" }
          : { daily_runs: 0 };
    await db.query("UPDATE settings SET value=value||$1::jsonb", [
      JSON.stringify(replacement),
    ]);
    pending.resolve(account(allowed));
    await running;
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id]))
        .status,
    ).toBe("queued");
    expect(s.calls).toHaveLength(0);
    expect(await db.query("SELECT id FROM runs")).toHaveLength(0);
    expect(
      await db.query("SELECT id FROM notifications WHERE kind='budget'"),
    ).toHaveLength(0);
  },
);

it.each([
  ["cancel", false],
  ["amend", false],
  ["cancel", true],
  ["amend", true],
] as const)(
  "起始額度讀取等待時 %s，allowed=%s 不得復活舊核准任務",
  async (action, allowed) => {
    const s = await scenario("quota"),
      entered = deferred<void>(),
      pending = deferred<ReturnType<typeof account>>();
    s.runner.account = async () => {
      entered.resolve();
      return pending.promise;
    };
    // Execution 在建構時已綁定 account；以替換後 adapter 重建實際執行服務。
    const execution = new Execution(
      db,
      s.github,
      new Line(db),
      new Budget(db),
      s.runner,
    );
    const running = execution.execute(s.task.id);
    await entered.promise;
    await new Tasks(db).action(
      s.task.id,
      action,
      1,
      "驗收管理者",
      action === "amend"
        ? { summary: "改成新的驗收要求", acceptance: ["符合新版需求"] }
        : {},
    );
    pending.resolve(account(allowed));
    await running;
    const latest = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(latest.status).toBe(
      action === "cancel" ? "cancelled" : "awaiting_approval",
    );
    expect(latest.version).toBe(action === "cancel" ? 1 : 2);
    expect(s.calls).toHaveLength(0);
    expect(await db.query("SELECT id FROM runs")).toHaveLength(0);
    expect(
      await db.query("SELECT id FROM notifications WHERE kind='budget'"),
    ).toHaveLength(0);
  },
);

it.each(["cancel", "deadline"] as const)(
  "code 前額度重讀等待期間 %s，回覆允許後仍不可呼叫模型",
  async (change) => {
    const s = await scenario("quota"),
      entered = deferred<void>(),
      pending = deferred<ReturnType<typeof account>>();
    let accountReads = 0;
    s.runner.account = async () => {
      if (++accountReads === 1) return account(true);
      entered.resolve();
      return pending.promise;
    };
    const original = s.runner.call.bind(s.runner);
    s.runner.call = async <T>(path: string, body: unknown): Promise<T> => {
      const value = await original<T>(path, body);
      if ((body as { phase?: string }).phase === "install") await expire();
      return value;
    };
    const execution = new Execution(
      db,
      s.github,
      new Line(db),
      new Budget(db),
      s.runner,
    );
    const running = execution.execute(s.task.id);
    await entered.promise;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (change === "cancel")
        await new Tasks(db).action(s.task.id, "cancel", 1, "驗收管理者");
      else {
        const future = Date.now() + 31 * 60000;
        clock = vi.spyOn(Date, "now").mockReturnValue(future);
      }
      pending.resolve({
        allowed: true,
        checkedAt: new Date(Date.now()).toISOString(),
      });
      await running;
      expect(s.calls).toEqual(["install"]);
      expect(s.github.publish).not.toHaveBeenCalled();
      const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
        s.task.id,
      ]);
      expect(task.status).toBe(change === "cancel" ? "cancelled" : "failed");
      if (change === "deadline")
        expect(task.last_error).toContain("超過 30 分鐘");
    } finally {
      clock?.mockRestore();
    }
  },
);
