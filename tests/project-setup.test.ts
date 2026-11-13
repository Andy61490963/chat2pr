import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, fixture, reset, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { GitHub } from "../server/github.js";
import {
  Execution,
  type Runner,
  type PhaseResult,
} from "../server/execution.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import type { Project } from "../shared/types.js";
import { prReport } from "../server/pr-body.js";
import { Octokit } from "@octokit/rest";
import { emptyContext, type InputQuestion } from "../shared/project-context.js";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ openaiKey: "fictional-setup-key" }),
}));

let app: Awaited<ReturnType<typeof buildApp>>;
const files = {
  "package.json": '{"scripts":{"test":"vitest run","build":"vite build"}}',
};
const answer = {
  summary: "",
  questions: [] as InputQuestion[],
  install: "npm ci",
  test: "npm test",
  verification: "tests",
  dataSource: "none",
  limitations: "",
  explanation: "依套件腳本安裝並執行測試",
  evidence: [{ path: "package.json", quote: '"test":"vitest run"' }],
};
beforeEach(async () => {
  await reset();
  await db.query("DELETE FROM service_health");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
  );
});
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

async function scenario() {
  const id = await fixture();
  await db.query(
    "UPDATE projects SET setup_mode='auto',install_command='',test_command='',enabled=false,validated_at=NULL WHERE id=$1",
    [id],
  );
  const github = new GitHub();
  github.base = vi.fn(async () => "fixed-commit");
  github.setupContext = vi.fn(async () => ({
    files,
    locks: [{ path: "package-lock.json", sha: "lock-sha" }],
  }));
  github.archive = vi.fn(async () => new Blob(["來源"]).stream());
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let response = { ...answer },
    fail = "",
    changedFiles = false;
  const runner: Runner = {
    account: async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    }),
    upload: vi.fn(async () => {}),
    call: async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as Record<string, unknown>;
      calls.push({ path, body });
      return {
        exitCode: body.phase === fail ? 1 : 0,
        stderr: body.phase === fail ? "缺少測試資料庫" : "",
        stdout:
          path === "ai"
            ? JSON.stringify({ final: JSON.stringify(response) })
            : body.phase === "collect"
              ? JSON.stringify({
                  files: changedFiles ? [{ path: "package.json" }] : [],
                })
              : "全部通過",
      } as T;
    },
  };
  const execution = new Execution(
    db,
    github,
    new Line(db),
    new Budget(db),
    runner,
  );
  app = await buildApp(db, async (projectId) => {
    await execution.validate(
      await db.one<Project>("SELECT * FROM projects WHERE id=$1", [projectId]),
    );
  });
  const headers = await session();
  const validate = () =>
    app.inject({
      method: "POST",
      url: `/api/projects/${id}/validate`,
      headers,
    });
  const project = () =>
    db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
  return {
    id,
    github,
    runner,
    execution,
    calls,
    validate,
    project,
    headers,
    change: (overrides: Partial<typeof answer>) => {
      response = { ...answer, ...overrides };
    },
    fail: (phase: string) => {
      fail = phase;
    },
    mutate: () => {
      changedFiles = true;
    },
  };
}

it("管理 API 新增預設自動；驗證成功才保存命令並啟用，手動欄位不被覆寫", async () => {
  const s = await scenario();
  expect((await s.validate()).statusCode).toBe(202);
  const p = await s.project();
  expect(p).toMatchObject({
    enabled: true,
    install_command: "",
    test_command: "",
    setup_status: "安裝與測試通過",
  });
  expect(p.setup_plan).toMatchObject({
    branch: "main",
    sha: "fixed-commit",
    install: "npm ci",
    test: "npm test",
    verification: "tests",
  });
  expect(
    s.calls
      .filter((c) => c.path === "phase")
      .map((c) => [c.body.phase, c.body.command]),
  ).toEqual([
    ["install", "npm ci"],
    ["test", "npm test"],
    ["collect", undefined],
  ]);
  expect(s.calls.at(-1)?.path).toBe("dispose");
  vi.spyOn(GitHub.prototype, "installation").mockResolvedValue(1);
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: s.headers,
    payload: {
      name: "新專案",
      repo: "test/new",
      base_branch: "develop",
      image: "worker:test",
      sensitive_paths: [],
      enabled: false,
    },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({
    setup_mode: "auto",
    test_command: "",
  });
});

it("相同建置設定沿用已驗證命令；鎖定檔變動必須重新判讀", async () => {
  const s = await scenario();
  await s.validate();
  await s.validate();
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(1);
  s.github.setupContext = async () => ({
    files,
    locks: [{ path: "package-lock.json", sha: "new-lock" }],
  });
  await s.validate();
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(2);
});

it("從管理 API 更換分支或模式，清除舊驗證與 AI 設定並增加版本", async () => {
  const s = await scenario();
  await s.validate();
  const p = await s.project();
  const updated = await app.inject({
    method: "PUT",
    url: `/api/projects/${s.id}`,
    headers: s.headers,
    payload: { ...p, base_branch: "develop", enabled: false },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    validated_at: null,
    setup_plan: null,
    config_version: p.config_version + 1,
  });
  await s.validate();
  expect((await s.project()).setup_plan?.branch).toBe("develop");
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(2);
});

it.each(["install", "test"])(
  "%s 失敗不會改用跳過命令，停用並清理容器",
  async (phase) => {
    const s = await scenario();
    s.fail(phase);
    expect((await s.validate()).statusCode).toBeGreaterThanOrEqual(400);
    expect(await s.project()).toMatchObject({
      enabled: false,
      validated_at: null,
      setup_plan: null,
    });
    expect((await s.project()).validation_error).toContain("缺少測試資料庫");
    expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(3);
    expect(s.calls.at(-1)?.path).toBe("dispose");
  },
);

it.each([
  "true",
  "echo done",
  "npm test || true",
  "vitest run --passWithNoTests",
])("拒絕以 %s 假裝測試通過", async (test) => {
  const s = await scenario();
  s.change({ test });
  expect((await s.validate()).statusCode).toBe(422);
  expect(s.calls.some((c) => c.path === "phase")).toBe(false);
  expect((await s.project()).enabled).toBe(false);
});

it("虛構引用與不足資訊皆不執行安裝", async () => {
  const s = await scenario();
  s.change({ evidence: [{ path: "other/package.json", quote: "vitest run" }] });
  expect((await s.validate()).statusCode).toBe(422);
  s.change({
    verification: "needs_input",
    explanation: "請提供測試資料庫的隔離環境",
    test: "",
    install: "",
  });
  const result = await s.validate();
  expect(result.statusCode).toBe(202);
  expect((await s.project()).setup_input?.details).toContain(
    "請提供測試資料庫",
  );
  expect((await s.project()).setup_input?.reason).toContain("你才知道的資訊");
  expect(s.calls.some((c) => c.path === "phase")).toBe(false);
});

it("判讀沙箱限制是系統錯誤，不建立補問或要求使用者修復容器", async () => {
  const s = await scenario();
  s.change({
    verification: "needs_input",
    install: "",
    test: "",
    summary: "沙箱阻止命令啟動",
    explanation: "嘗試 exec 遭到 operation not permitted",
    questions: [{ kind: "information", question: "請管理者提供可寫入的容器" }],
  });
  expect((await s.validate()).statusCode).toBe(503);
  expect((await s.project()).setup_input).toBeNull();
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='project_input'"),
  ).toHaveLength(0);
  expect(s.calls.at(-1)?.path).toBe("dispose");
});

it("第一次測試失敗後 AI 使用診斷自行調整，成功才啟用，不要求使用者安裝服務", async () => {
  const s = await scenario(),
    call = s.runner.call;
  let attempts = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (
      path === "phase" &&
      (raw as { phase: string }).phase === "test" &&
      attempts++ === 0
    )
      return { exitCode: 1, stdout: "", stderr: "本機 Redis 尚未啟動" } as T;
    return call<T>(path, raw);
  };
  expect((await s.validate()).statusCode).toBe(202);
  expect(attempts).toBe(2);
  const prompts = s.calls
    .filter((c) => c.path === "ai")
    .map((c) => JSON.stringify(c.body));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("本機 Redis 尚未啟動");
  expect(await s.project()).toMatchObject({ enabled: true, setup_input: null });
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='project_input'"),
  ).toHaveLength(0);
});

it("實際失敗需要私有資料時只發布白話問題，技術細節分開保存並清理", async () => {
  const s = await scenario(),
    call = s.runner.call;
  let attempts = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase: string }).phase === "test") {
      attempts++;
      s.change({
        verification: "needs_input",
        install: "",
        test: "",
        summary: "還缺測試用的資料，暫時無法完成驗證。",
        explanation: "已嘗試執行測試；找不到初始化資料。",
        questions: [
          {
            kind: "information",
            question:
              "測試資料放在哪裡？可以提供檔案位置，不知道也可以直接說。",
          },
        ],
      });
      return { exitCode: 1, stdout: "", stderr: "缺少初始化資料" } as T;
    }
    return call<T>(path, raw);
  };
  expect((await s.validate()).statusCode).toBe(202);
  expect(attempts).toBe(1);
  expect((await s.project()).setup_input).toMatchObject({
    reason: "還缺測試用的資料，暫時無法完成驗證。",
    details: "已嘗試執行測試；找不到初始化資料。",
  });
  expect(s.calls.at(-1)?.path).toBe("dispose");
  await s.validate();
  expect(attempts).toBe(1);
});

it("自動調整期間設定變更，不能繼續舊版本測試或啟用", async () => {
  const s = await scenario(),
    call = s.runner.call;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase: string }).phase === "install") {
      await db.query(
        "UPDATE projects SET config_version=config_version+1 WHERE id=$1",
        [s.id],
      );
      return { exitCode: 1, stdout: "", stderr: "套件安裝中斷" } as T;
    }
    return call<T>(path, raw);
  };
  expect((await s.validate()).statusCode).toBe(409);
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(1);
  expect((await s.project()).validated_at).toBeNull();
});

it("只有建置時，看板及 PR 明確標示未執行自動測試", async () => {
  const s = await scenario();
  s.change({
    test: "npm run build",
    verification: "build",
    explanation: "只有建置檢查，未執行自動測試",
  });
  expect((await s.validate()).statusCode).toBe(202);
  expect((await s.project()).setup_status).toBe("建置通過；未執行自動測試");
  const body = prReport({
    codexSummary: "修改完成",
    testCommand: "npm run build",
    testOutput: "built in 1s",
    verification: "build",
  });
  expect(body).toContain("建置：通過；未執行自動測試");
  expect(body).not.toContain("測試：通過");
});

it("驗證期間改設定，舊命令不能繼續執行或發布", async () => {
  const s = await scenario();
  s.github.archive = async () => {
    const p = await s.project();
    const r = await app.inject({
      method: "PUT",
      url: `/api/projects/${s.id}`,
      headers: s.headers,
      payload: { ...p, base_branch: "release", enabled: false },
    });
    expect(r.statusCode).toBe(200);
    return new Blob(["來源"]).stream();
  };
  expect((await s.validate()).statusCode).toBe(409);
  expect(s.calls.some((c) => c.path === "phase")).toBe(false);
  expect(await s.project()).toMatchObject({
    base_branch: "release",
    setup_plan: null,
    enabled: false,
  });
});

it("同一專案重複驗證，不會同時重開 AI 或容器", async () => {
  const s = await scenario();
  const original = s.github.archive;
  s.github.archive = async () => {
    expect(await s.execution.validate(await s.project())).toEqual({
      ok: false,
    });
    return original(await s.project(), "fixed-commit");
  };
  expect((await s.validate()).statusCode).toBe(202);
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(1);
});

it("安裝或測試修改了專案內容，不保存成功結果", async () => {
  const s = await scenario();
  s.mutate();
  expect((await s.validate()).statusCode).toBe(422);
  expect(await s.project()).toMatchObject({ enabled: false, setup_plan: null });
});

it("暫停或訂閱額度不可用時，不呼叫 AI", async () => {
  const s = await scenario();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
  );
  expect((await s.validate()).statusCode).toBe(409);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','false')",
  );
  s.runner.account = async () => ({
    allowed: false,
    checkedAt: new Date().toISOString(),
  });
  const execution = new Execution(
    db,
    s.github,
    new Line(db),
    new Budget(db),
    s.runner,
  );
  await expect(execution.validate(await s.project())).rejects.toThrow(
    "訂閱額度",
  );
  expect(s.calls.some((c) => c.path === "ai")).toBe(false);
});

it("API 模式記錄用量並釋放預留額度，沒有額度時不呼叫模型", async () => {
  const s = await scenario();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"api\"')",
  );
  const fetch = vi.fn(async () =>
    Response.json({
      id: "fake-response",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(answer),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 100,
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await s.validate()).statusCode).toBe(202);
  expect(fetch).toHaveBeenCalledOnce();
  expect(
    (
      await db.one<{ count: number }>(
        "SELECT count(*)::int AS count FROM usage",
      )
    ).count,
  ).toBe(1);
  expect(
    await db.query("SELECT 1 FROM reservations WHERE NOT released"),
  ).toHaveLength(0);
  await db.query("UPDATE projects SET setup_plan=NULL,validated_at=NULL");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{daily_budget}','0')",
  );
  expect((await s.validate()).statusCode).toBe(429);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  "No test is available in this assembly",
  "ℹ tests 0",
  "0 tests passed",
  "Tests run: 0",
])("命令成功但沒有找到測試（%s），不標示測試通過", async (stdout) => {
  const s = await scenario(),
    call = s.runner.call;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase: string }).phase === "test")
      return {
        exitCode: 0,
        stdout,
        stderr: "",
      } as T;
    return call<T>(path, raw);
  };
  expect((await s.validate()).statusCode).toBe(422);
  expect((await s.project()).enabled).toBe(false);
});

it("npm 套件版本 1.0.0 test 不會被誤認為零個測試", async () => {
  const s = await scenario(),
    call = s.runner.call;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase: string }).phase === "test")
      return {
        exitCode: 0,
        stdout:
          "> example@1.0.0 test\n> node --test\nℹ tests 1\nℹ pass 1\nℹ fail 0",
        stderr: "",
      } as T;
    return call<T>(path, raw);
  };
  expect((await s.validate()).statusCode).toBe(202);
  expect((await s.project()).setup_status).toBe("安裝與測試通過");
});

it("讀取固定 commit 的真實 CI 與套件設定，排除機密、符號連結及自訂敏感路徑", async () => {
  const s = await scenario(),
    github = new GitHub();
  const source: Record<string, string> = {
    ".github/workflows/ci.yml": "steps:\n  - run: npm ci\n  - run: npm test",
    "package.json": files["package.json"],
    "private/README.md": "不得提供",
    ".local/README.md": "不得提供",
    "linked/README.md": "符號連結",
    "NuGet.Config":
      "<packageSourceCredentials><Password>fictional-only</Password></packageSourceCredentials>",
    "pnpm-lock.yaml": "只提供雜湊",
  };
  const fetched: string[] = [];
  const api = new Octokit({
    request: {
      fetch: async (url: string) => {
        const u = new URL(url);
        if (u.pathname.includes("/git/trees/")) {
          expect(u.pathname.endsWith("/fixed-commit")).toBe(true);
          return Response.json({
            truncated: false,
            tree: Object.keys(source).map((path) => ({
              path,
              sha: "blob",
              type: "blob",
              size: 100,
              mode: path.startsWith("linked/") ? "120000" : "100644",
            })),
          });
        }
        expect(u.searchParams.get("ref")).toBe("fixed-commit");
        const path = decodeURIComponent(u.pathname.split("/contents/")[1]);
        fetched.push(path);
        return Response.json({
          type: "file",
          content: Buffer.from(source[path]).toString("base64"),
        });
      },
    },
  });
  github.client = async () => api;
  const context = await github.setupContext(
    { ...(await s.project()), sensitive_paths: ["private/"] },
    "fixed-commit",
  );
  expect(context.files).toEqual({
    ".github/workflows/ci.yml": source[".github/workflows/ci.yml"],
    "package.json": files["package.json"],
  });
  expect(fetched).not.toContain("pnpm-lock.yaml");
  expect(fetched).not.toContain("linked/README.md");
  expect(context.locks).toEqual([{ path: "pnpm-lock.yaml", sha: "blob" }]);
});

function setupFiles(github: GitHub, source: Record<string, string>) {
  const fetched: string[] = [];
  github.client = async () =>
    new Octokit({
      request: {
        fetch: async (url: string) => {
          const u = new URL(url);
          if (u.pathname.includes("/git/trees/")) {
            expect(u.pathname.endsWith("/fixed-commit")).toBe(true);
            return Response.json({
              truncated: false,
              tree: Object.entries(source).map(([path, content]) => ({
                path,
                sha: `blob-${path}`,
                type: "blob",
                mode: "100644",
                size: Buffer.byteLength(content),
              })),
            });
          }
          expect(u.searchParams.get("ref")).toBe("fixed-commit");
          const path = decodeURIComponent(u.pathname.split("/contents/")[1]);
          fetched.push(path);
          return Response.json({
            type: "file",
            content: Buffer.from(source[path]).toString("base64"),
          });
        },
      },
    });
  github.setupContext = GitHub.prototype.setupContext.bind(github);
  return fetched;
}

it("長篇 README 的尾端測試手順仍可供管理 API 自動驗證，不要求手動指令", async () => {
  const s = await scenario();
  setupFiles(s.github, {
    "README.md":
      "# 專案說明\n" +
      "歷史功能說明與欄位清單。\n".repeat(1500) +
      "\n## 安裝與測試\nnpm ci\nnpm test\n",
    ...files,
  });
  s.change({ evidence: [{ path: "README.md", quote: "npm test" }] });
  expect((await s.validate()).statusCode).toBe(202);
  expect((await s.project()).enabled).toBe(true);
  expect((await s.project()).setup_input).toBeNull();
  const prompt = (
    s.calls.find((c) => c.path === "ai")!.body.job as { prompt: string }
  ).prompt;
  expect(prompt).toContain("僅提供安裝、測試與環境相關原文摘錄");
  expect(s.calls.some((c) => c.body.phase === "test")).toBe(true);
});

it("README 摘錄前先掃描完整內容，尾端有虛構機密時整份排除", async () => {
  const s = await scenario();
  setupFiles(s.github, {
    ...files,
    "README.md":
      "# 說明\n" +
      "一般功能說明\n".repeat(5000) +
      '\ntoken = "fictional-only-secret-value"\n',
  });
  const context = await s.github.setupContext(
    await s.project(),
    "fixed-commit",
  );
  expect(context.files["README.md"]).toBeUndefined();
  expect(context.files["package.json"]).toBe(files["package.json"]);
});

it("多份長說明不會擠掉建置設定，UTF-8 原文與總量上限保持有效", async () => {
  const s = await scenario();
  const source: Record<string, string> = {
    ...files,
    "scripts/test.mjs": "console.log('實際測試入口');",
  };
  for (let i = 0; i < 8; i++)
    source[`docs/${i}/README.md`] =
      "# 說明\n" +
      "繁體中文🙂功能細節\n".repeat(4000) +
      "\n## 測試\nnpm test\n";
  const fetched = setupFiles(s.github, source);
  const context = await s.github.setupContext(
    await s.project(),
    "fixed-commit",
  );
  expect(fetched.slice(0, 2)).toEqual(["package.json", "scripts/test.mjs"]);
  expect(context.files["scripts/test.mjs"]).toBe(source["scripts/test.mjs"]);
  expect(
    Object.values(context.files).reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    ),
  ).toBeLessThanOrEqual(100000);
  expect(context.files["docs/0/README.md"]).toContain("npm test");
  expect(context.files["docs/0/README.md"]).not.toContain("�");
  expect(context.omissions?.length).toBe(8);
});

it("超大 README 不下載；實際建置設定過大仍停止，不假裝讀取完整設定", async () => {
  const s = await scenario();
  const fetched = setupFiles(s.github, {
    ...files,
    "README.md": "大量說明".repeat(100000),
  });
  const context = await s.github.setupContext(
    await s.project(),
    "fixed-commit",
  );
  expect(fetched).toEqual(["package.json"]);
  expect(context.omissions?.[0].reason).toContain("未提供內容");
  setupFiles(s.github, { "package.json": " ".repeat(24001) });
  await expect(
    s.github.setupContext(await s.project(), "fixed-commit"),
  ).rejects.toThrow("建置設定 package.json 過大");
});

it("補問只通知一次、不重開容器，回覆後帶入資訊重新驗證", async () => {
  const s = await scenario();
  s.change({
    verification: "needs_input",
    test: "",
    install: "",
    explanation: "需要隔離資料庫",
    questions: [{ kind: "information", question: "授權伺服器的網址是什麼？" }],
  });
  await s.validate();
  const p = await s.project();
  expect(p.setup_input?.questions[0].question).toContain("授權伺服器");
  expect(p.setup_status).toBe("等待你補充資訊");
  await s.validate();
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(1);
  expect(s.calls.some((c) => c.path === "phase")).toBe(false);
  expect(
    await db.query("SELECT id FROM notifications WHERE kind='project_input'"),
  ).toHaveLength(1);
  s.change({});
  const response = await app.inject({
    method: "PUT",
    url: `/api/projects/${s.id}/context`,
    headers: s.headers,
    payload: {
      configVersion: p.config_version,
      context: emptyContext,
      requestId: p.setup_input!.id,
      answers: ["使用 scripts/test-db.sql 建立隔離資料庫"],
      validate: true,
    },
  });
  expect(response.statusCode).toBe(200);
  expect((await s.project()).validated_at).toBeTruthy();
  expect((await s.project()).setup_input).toBeNull();
  const prompt = (
    s.calls.filter((c) => c.path === "ai").at(-1)!.body.job as {
      prompt: string;
    }
  ).prompt;
  expect(prompt).toContain("scripts/test-db.sql");
  expect((await s.project()).project_context?.notes).toContain("回覆：");
  const replay = await app.inject({
    method: "PUT",
    url: `/api/projects/${s.id}/context`,
    headers: s.headers,
    payload: {
      configVersion: p.config_version,
      context: emptyContext,
      requestId: p.setup_input!.id,
      answers: ["重複回答"],
    },
  });
  expect(replay.statusCode).toBe(409);
});

it("專案資訊與未合併記憶都提供給設定 AI；編輯後清除舊驗證並拒絕過期頁面", async () => {
  const s = await scenario();
  await s.validate();
  const p = await s.project();
  const body = {
    configVersion: p.config_version,
    context: {
      ...emptyContext,
      environment: "使用隔離 SQL Server 與 Redis",
      constraints: "禁止寫入正式資料庫",
    },
  };
  const save = await app.inject({
    method: "PUT",
    url: `/api/projects/${s.id}/context`,
    headers: s.headers,
    payload: body,
  });
  expect(save.statusCode).toBe(200);
  expect(await s.project()).toMatchObject({
    enabled: false,
    validated_at: null,
    setup_plan: null,
    config_version: p.config_version + 1,
  });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/projects/${s.id}/context`,
        headers: s.headers,
        payload: body,
      })
    ).statusCode,
  ).toBe(409);
  await app.inject({
    method: "POST",
    url: `/api/projects/${s.id}/knowledge`,
    headers: s.headers,
    payload: { content: "測試時間固定使用 UTC" },
  });
  await s.validate();
  const prompt = (
    s.calls.filter((c) => c.path === "ai").at(-1)!.body.job as {
      prompt: string;
    }
  ).prompt;
  expect(prompt).toContain("隔離 SQL Server");
  expect(prompt).toContain("測試時間固定使用 UTC");
});

it("補答需要登入管理權限；拒絕將密碼與驗證碼存入長期資訊", async () => {
  const s = await scenario();
  const p = await s.project();
  const url = `/api/projects/${s.id}/context`;
  const payload = { configVersion: p.config_version, context: emptyContext };
  expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(
    401,
  );
  for (const secret of [
    "密碼：fictional-only",
    "password=fake-only",
    "123456",
    "postgres://fake:fake@example.test/db",
  ]) {
    const r = await app.inject({
      method: "PUT",
      url,
      headers: s.headers,
      payload: { ...payload, context: { ...emptyContext, notes: secret } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).not.toContain(secret);
  }
  expect((await s.project()).project_context).toEqual({});
});

it("外部驗證問題只能回報完成，回報後仍執行驗證，不直接啟用", async () => {
  const s = await scenario();
  s.change({
    verification: "needs_input",
    explanation: "需要套件來源授權",
    questions: [{ kind: "authentication", question: "請到套件服務完成授權" }],
  });
  await s.validate();
  const p = await s.project();
  const payload = {
    configVersion: p.config_version,
    context: emptyContext,
    requestId: p.setup_input!.id,
    answers: ["fictional-code"],
    validate: true,
  };
  const url = `/api/projects/${s.id}/context`;
  expect(
    (await app.inject({ method: "PUT", url, headers: s.headers, payload }))
      .statusCode,
  ).toBe(422);
  s.change({});
  s.fail("install");
  const result = await app.inject({
    method: "PUT",
    url,
    headers: s.headers,
    payload: { ...payload, answers: ["已在服務完成驗證"] },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().queued).toBe(false);
  expect((await s.project()).enabled).toBe(false);
  expect(s.calls.some((c) => c.body.phase === "install")).toBe(true);
});

it("AI 新增測試篩選時先詢問完整環境，不採用縮小範圍的命令", async () => {
  const s = await scenario();
  s.change({ test: "npm test -- --exclude integration" });
  await s.validate();
  expect((await s.project()).setup_input?.reason).toContain("縮小測試範圍");
  expect(s.calls.some((c) => c.path === "phase")).toBe(false);
});

it("舊 AI 回覆不能在專案資訊更新後發布問題", async () => {
  const s = await scenario();
  const original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "ai") {
      const p = await s.project();
      await app.inject({
        method: "PUT",
        url: `/api/projects/${s.id}/context`,
        headers: s.headers,
        payload: {
          configVersion: p.config_version,
          context: { ...emptyContext, testing: "測試準備已更新" },
        },
      });
    }
    return original<T>(path, raw);
  };
  s.change({ verification: "needs_input", explanation: "過期的問題" });
  await s.validate();
  expect((await s.project()).setup_input).toBeNull();
  expect(
    await db.query("SELECT id FROM notifications WHERE kind='project_input'"),
  ).toHaveLength(0);
});

it("資料庫類補問先被攔下；AI 改用推測結構後直接完成驗證，不等人回答", async () => {
  const s = await scenario();
  s.change({
    verification: "needs_input",
    test: "",
    install: "",
    explanation: "找不到建庫腳本",
    questions: [
      { kind: "information", question: "測試資料庫的結構要去哪裡拿？" },
    ],
  });
  const original = s.runner.call.bind(s.runner);
  let asked = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const result = await original<T>(path, raw);
    if (path === "ai" && ++asked === 1)
      s.change({ dataSource: "inferred", explanation: "依模型類別推測結構" });
    return result;
  };
  await s.validate();
  const ai = s.calls.filter((c) => c.path === "ai");
  expect(ai).toHaveLength(2);
  expect(JSON.stringify(ai[1].body)).toContain("policyReminder");
  const p = await s.project();
  expect(p.setup_input).toBeNull();
  expect(p.enabled).toBe(true);
  expect(p.setup_status).toBe("安裝與測試通過（資料庫結構由 AI 推測）");
  expect(p.setup_plan?.dataSource).toBe("inferred");
  expect(
    await db.query("SELECT id FROM notifications WHERE kind='project_input'"),
  ).toHaveLength(0);
});

it("提醒後仍堅持就資料庫補問時才交給使用者，而且只多問一次 AI", async () => {
  const s = await scenario();
  s.change({
    verification: "needs_input",
    test: "",
    install: "",
    explanation: "沒有任何資料存取程式碼可以推測",
    questions: [{ kind: "information", question: "資料庫的種子資料在哪裡？" }],
  });
  await s.validate();
  expect(s.calls.filter((c) => c.path === "ai")).toHaveLength(2);
  expect((await s.project()).setup_status).toBe("等待你補充資訊");
});

it("部分測試必須說明排除範圍，通過後狀態與 PR 都標示不是完整驗證", async () => {
  const s = await scenario();
  s.change({
    verification: "partial",
    test: "npm test -- --exclude integration",
    limitations: "",
  });
  await s.validate();
  expect((await s.project()).validation_error).toContain("沒有說明排除了什麼");
  expect((await s.project()).enabled).toBe(false);

  await db.query("UPDATE projects SET validation_error=NULL WHERE id=$1", [
    s.id,
  ]);
  s.change({
    verification: "partial",
    test: "npm test -- --exclude integration",
    limitations: "整合測試需要產線的真實資料，已排除",
  });
  await s.validate();
  const p = await s.project();
  expect(p.enabled).toBe(true);
  expect(p.setup_status).toBe("部分測試通過；AI 依環境限制縮小了測試範圍");
  expect(p.setup_plan).toMatchObject({
    verification: "partial",
    limitations: "整合測試需要產線的真實資料，已排除",
  });
  const body = prReport({
    codexSummary: "調整報表",
    testCommand: p.setup_plan!.test,
    testOutput: "",
    verification: p.setup_plan!.verification,
    limitations: p.setup_plan!.limitations,
  });
  expect(body).toContain("測試：部分通過");
  expect(body).toContain("整合測試需要產線的真實資料");
  expect(
    prReport({
      codexSummary: "調整報表",
      testCommand: "npm test",
      testOutput: "",
      verification: "tests",
      dataSource: "inferred",
    }),
  ).toContain("資料庫結構由 AI 從程式碼推測");
});

it("有結構快照時掛進工作容器並告訴規劃器，驗證結果標示以快照模擬", async () => {
  const s = await scenario();
  await db.query(
    "INSERT INTO project_schema_snapshots(project_id,version,engine,hash,objects,tables,files,bytes) VALUES($1,1,'sqlserver','fictional-hash',$2,$3,$4,10)",
    [
      s.id,
      JSON.stringify({ tables: 1 }),
      JSON.stringify(["dbo.Orders"]),
      JSON.stringify({
        "schema.sql": "CREATE TABLE [dbo].[Orders] ([Id] int NOT NULL);",
        "README.md": "說明",
      }),
    ],
  );
  s.change({ dataSource: "snapshot" });
  await s.validate();
  const provided = s.calls.find((c) => c.path === "environment-files");
  expect(provided?.body.files).toEqual(
    expect.arrayContaining([
      {
        path: "database/schema.sql",
        content: "CREATE TABLE [dbo].[Orders] ([Id] int NOT NULL);",
      },
    ]),
  );
  const order = s.calls.map((c) => c.path);
  expect(order.indexOf("environment-files")).toBeLessThan(
    order.indexOf("phase"),
  );
  const prompt = JSON.stringify(s.calls.find((c) => c.path === "ai")?.body);
  expect(prompt).toContain("/agentflow/env/database");
  expect(prompt).toContain("dbo.Orders");
  expect(prompt).not.toContain("CREATE TABLE");
  expect((await s.project()).setup_status).toBe(
    "安裝與測試通過（資料庫以結構快照模擬）",
  );
});

it("沒有快照卻回報使用快照時，如實標示為 AI 推測", async () => {
  const s = await scenario();
  s.change({ dataSource: "snapshot" });
  await s.validate();
  expect(s.calls.some((c) => c.path === "environment-files")).toBe(false);
  expect((await s.project()).setup_plan?.dataSource).toBe("inferred");
});
