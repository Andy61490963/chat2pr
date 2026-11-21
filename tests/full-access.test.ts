import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, reset, fixture, confirmTask, session } from "./helpers.js";
import {
  Execution,
  type Runner,
  type PhaseResult,
} from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { seal } from "../server/project-database.js";
import { FULL_ACCESS_ENV } from "../server/containers.js";
import { fullAccessNote, noFullAccess } from "../server/full-access.js";
import { SCRUBBED, scrubber, scrubResult } from "../server/secret-scrub.js";
import { buildApp } from "../server/app.js";
import type { Task } from "../shared/types.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ sessionSecret: "fictional-session-secret-for-tests" }),
}));

// 全部是虛構憑證。
const password = "Fictional-Mes-Pass-789";

async function scenario(opts: { full: boolean; leak?: boolean }) {
  const projectId = await fixture();
  await db.query("UPDATE projects SET full_access=$2 WHERE id=$1", [
    projectId,
    opts.full,
  ]);
  await db.query(
    "INSERT INTO project_connections(project_id,engine,host,port,database_name,username,secret) VALUES($1,'sqlserver','mes.example.test',1433,'MES_TEST','mes_user',$2)",
    [projectId, seal({ password })],
  );
  const task = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) VALUES($1,'group-a','查機台','查 T09 是否在生產','[\"列出結果\"]','queued',1,'full') RETURNING *",
    [projectId],
  );
  await confirmTask(task.id);
  const github = new GitHub();
  let published = 0;
  github.base = async () => "base-sha";
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/test/repo/issues/1",
  });
  github.findPr = async () => undefined!;
  github.publish = async (_p, _t, _files, _report, guard) => {
    await guard?.();
    published++;
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  const calls: Array<Record<string, unknown>> = [];
  const runner: Runner = {
    async upload() {},
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as Record<string, unknown> & { phase: string };
      const result: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
      if (path === "phase") {
        calls.push(body);
        if (body.phase === "code")
          result.observations = [
            {
              seq: 1,
              at: new Date().toISOString(),
              phase: "code",
              kind: "message",
              detail: `sqlcmd -S mes.example.test -P ${password}`,
            },
          ];
        if (body.phase === "collect")
          result.stdout = JSON.stringify({
            files: [
              {
                path: "src/report.ts",
                content: Buffer.from(
                  opts.leak ? `const pw = "${password}";` : "export {};",
                ).toString("base64"),
                mode: "100644",
              },
            ],
          });
        if (body.phase === "review")
          result.stdout = JSON.stringify({
            final: JSON.stringify({ passed: true, findings: [] }),
          });
      }
      return result as T;
    },
  };
  const execution = new Execution(
    db,
    github,
    new Line(db),
    new Budget(db),
    runner,
  );
  return { task, execution, calls, published: () => published };
}

describe("專案的完全存取", () => {
  beforeEach(reset);
  afterAll(() => db.close());

  it("開啟後每個階段都開全網路，資料庫連線以環境變數交給容器；收集階段不給", async () => {
    const s = await scenario({ full: true });
    await s.execution.execute(s.task.id);
    const byPhase = (p: string) => s.calls.find((c) => c.phase === p)!;
    for (const p of ["test", "code", "review"]) {
      expect(byPhase(p).open).toBe(true);
      expect(byPhase(p).full).toBe(true);
      expect(byPhase(p).env).toEqual(
        expect.arrayContaining([
          "AGENTFLOW_DB_HOST=mes.example.test",
          "AGENTFLOW_DB_NAME=MES_TEST",
          `AGENTFLOW_DB_PASSWORD=${password}`,
          expect.stringMatching(
            /^AGENTFLOW_DB_CONNECTION=Server=mes\.example\.test,1433;Database=MES_TEST;User ID=mes_user;Password=/,
          ),
        ]),
      );
    }
    expect(byPhase("collect").env).toBeUndefined();
    const job = byPhase("code").job as Record<string, unknown>;
    expect(job.fullAccess).toBe(true);
    expect(job.open).toBe(true);
    // 告訴 Codex 可以直接連，但不要把密碼寫進檔案；提示詞本身不含密碼。
    expect(String(job.prompt)).toContain("AGENTFLOW_DB_CONNECTION");
    expect(String(job.prompt)).not.toContain(password);
    // 曾經同時寫著「不可連線正式資料庫」，Codex 因此拒用登記的 MES 連線、只回「無法判定」。
    expect(String(job.prompt)).not.toContain("不可連線正式資料庫。");
    expect(String(job.prompt)).toContain("登記的資料庫連線見 fullAccess");
    // 執行紀錄遮蔽密碼。
    const events = await db.query<{ detail: unknown }>(
      "SELECT detail FROM run_events",
    );
    expect(JSON.stringify(events)).not.toContain(password);
    expect(JSON.stringify(events)).toContain(SCRUBBED);
    expect(s.published()).toBe(1);
  });

  it("登記的 SSH 主機也交給容器，提示列出主機但不含密碼", async () => {
    const sshPassword = "Fictional-Ssh-Pass-321";
    const s = await scenario({ full: true });
    await db.query(
      "INSERT INTO project_ssh_hosts(project_id,name,host,port,username,note,secret) SELECT project_id,'jet-u01','10.0.7.31',22,'reader','U01 工控電腦',$1 FROM tasks WHERE id=$2",
      [seal({ password: "", sshPassword }), s.task.id],
    );
    await s.execution.execute(s.task.id);
    const code = s.calls.find((c) => c.phase === "code")!;
    expect(code.env).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AGENTFLOW_DB_CONNECTION=/),
        expect.stringMatching(/^AGENTFLOW_SSH_HOSTS=\[\{"name":"jet-u01"/),
      ]),
    );
    const prompt = String((code.job as Record<string, unknown>).prompt);
    expect(prompt).toContain("jet-u01（reader@10.0.7.31:22，U01 工控電腦）");
    expect(prompt).not.toContain(sshPassword);
    expect(s.calls.find((c) => c.phase === "collect")!.env).toBeUndefined();
  });

  it("沒開啟時維持隔離：不給資料庫連線、不開網路", async () => {
    const s = await scenario({ full: false });
    await s.execution.execute(s.task.id);
    for (const c of s.calls) {
      expect(c.env).toBeUndefined();
      expect(c.full).toBeUndefined();
      expect(c.open).toBe(false);
    }
    const code = s.calls.find((c) => c.phase === "code")!;
    expect(String((code.job as Record<string, unknown>).prompt)).toContain(
      "不可連線正式資料庫。",
    );
  });

  it("變更內容含資料庫密碼時拒絕發布", async () => {
    const s = await scenario({ full: true, leak: true });
    await s.execution.execute(s.task.id).catch(() => {});
    expect(s.published()).toBe(0);
    const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(task.last_error).toContain("變更內容包含資料庫密碼");
    expect(task.last_error).not.toContain(password);
  });

  it("只有管理者能開關，並寫進活動紀錄", async () => {
    const projectId = await fixture();
    const app = await buildApp(db);
    try {
      const anonymous = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/full-access`,
        payload: { enabled: true },
      });
      expect(anonymous.statusCode).toBe(401);
      const headers = await session();
      const on = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/full-access`,
        headers,
        payload: { enabled: true },
      });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toEqual({ id: projectId, full_access: true });
      const audit = await db.one<{ detail: string }>(
        "SELECT detail FROM audit WHERE kind='settings' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.detail).toContain("開啟專案 測試專案 的完全存取");
    } finally {
      await app.close();
    }
  });
});

it("完全存取提示提供內網連線診斷", () => {
  const note = fullAccessNote(noFullAccess);
  expect(note).toContain("ping -c 1 -W 3 <主機> 與 nc -z -w 3 <主機> <埠>");
  expect(note).toContain("這台伺服器到不了該位址（可能缺路由或 VPN）");
  expect(note).toContain("主機有回應但服務沒開");
  expect(note).toContain("若僅有逾時或未收到回應，寫明各項檢查結果");
});

describe("完全存取的安全邊界", () => {
  it("工作容器只接受 AGENTFLOW_DB_* 環境變數", () => {
    expect(FULL_ACCESS_ENV.test("AGENTFLOW_DB_HOST=db")).toBe(true);
    for (const bad of [
      "PATH=/tmp",
      "AGENTFLOW_DBX=1",
      "AGENTFLOW_SQLSERVER_CONNECTION=x",
      "agentflow_db_host=x",
    ])
      expect(FULL_ACCESS_ENV.test(bad)).toBe(false);
  });

  it("遮蔽也涵蓋 JSON 跳脫後的寫法，太短的值不處理", () => {
    const tricky = 'p"a\\ss';
    const scrub = scrubber([tricky, "ab"]);
    const result = scrubResult(
      { stdout: `密碼是 ${tricky}`, observations: [{ detail: tricky }] },
      scrub,
    );
    expect(JSON.stringify(result)).not.toContain("a\\\\ss");
    expect(result.stdout).toBe(`密碼是 ${SCRUBBED}`);
    expect(scrub("ab cd")).toBe("ab cd");
  });
});
