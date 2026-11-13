import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ sessionSecret: "fictional-session-secret-for-tests" }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { seal } from "../server/project-database.js";
import {
  approveCheck,
  checkProblem,
  CheckInput,
  createCheck,
  dailyNoticeLimit,
  runDueChecks,
  setCheckPaused,
  updateCheck,
  type RunnerCall,
} from "../server/checks.js";
import {
  assertReadOnlySelect,
  evaluateSql,
  inQuietHours,
  nextRunAt,
  type ScheduledCheck,
} from "../shared/checks.js";

let project: string;
beforeEach(async () => {
  await reset();
  project = await fixture();
});
afterAll(() => db.close());

describe("檢查定義", () => {
  it.each([
    "SELECT COUNT(*) AS stale FROM EQM WHERE last_report < DATEADD(minute,-30,GETDATE())",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x;",
    "SELECT name FROM t WHERE note='please update later'",
  ])("允許唯讀查詢：%s", (sql) => expect(assertReadOnlySelect(sql)).toBeNull());
  it.each([
    "SELECT 1; DELETE FROM t",
    "UPDATE t SET a=1",
    "SELECT * INTO backup_t FROM t",
    "EXEC sp_who",
    "SELECT * FROM #tmp",
    "DECLARE @a int SELECT @a",
    "SELECT * FROM OPENROWSET('x','y','z')",
  ])("拒絕會寫入或執行程序的查詢：%s", (sql) =>
    expect(assertReadOnlySelect(sql)).not.toBeNull(),
  );
  it("下次執行時間：固定間隔與每天固定時間（臺北）", () => {
    const from = new Date("2026-11-13T01:00:00Z"); // 臺北 09:00
    expect(
      nextRunAt({ interval_minutes: 60, daily_at: null }, from).toISOString(),
    ).toBe("2026-11-13T02:00:00.000Z");
    expect(
      nextRunAt(
        { interval_minutes: null, daily_at: "08:00" },
        from,
      ).toISOString(),
    ).toBe("2026-11-14T00:00:00.000Z");
    expect(
      nextRunAt(
        { interval_minutes: null, daily_at: "10:30" },
        from,
      ).toISOString(),
    ).toBe("2026-11-13T02:30:00.000Z");
  });
  it("靜音時段可以跨午夜", () => {
    const c = { quiet_from: "22:00", quiet_to: "07:00" };
    expect(inQuietHours(c, new Date("2026-11-13T15:00:00Z"))).toBe(true); // 臺北 23:00
    expect(inQuietHours(c, new Date("2026-11-13T01:00:00Z"))).toBe(false); // 臺北 09:00
  });
  it("SQL 判定與通知列出的欄位", () => {
    const rows = [
      { stale: 3, eqm: "M01" },
      { stale: 3, eqm: "M07" },
    ];
    expect(
      evaluateSql(
        { column: "stale", op: ">", value: 0, listColumn: "eqm" },
        rows,
      ),
    ).toEqual({
      alert: true,
      summary: "stale=3：M01、M07",
    });
    expect(
      evaluateSql({ column: "$rows", op: ">", value: 5 }, rows).alert,
    ).toBe(false);
  });
  it("排程、條件與目標格式不對時拒絕", () => {
    const base = CheckInput.parse({
      group_id: "group-a",
      name: "x",
      kind: "http",
      target: "http://10.0.0.5/health",
      interval_minutes: 60,
    });
    expect(checkProblem(base)).toBeNull();
    expect(checkProblem({ ...base, daily_at: "08:00" })).toContain("其中一種");
    expect(
      checkProblem({ ...base, kind: "tcp", target: "10.0.0.5" }),
    ).toContain("主機:連接埠");
    expect(
      checkProblem({ ...base, kind: "sql", target: "SELECT 1" }),
    ).toContain("專案");
    expect(checkProblem({ ...base, target: "http://user:pw@h/x" })).toContain(
      "帳密",
    );
  });
});

/** 模擬執行器：依序回傳指定結果；error 表示執行失敗。 */
function fakeRunner(results: ("ok" | "alert" | "error")[]) {
  const calls: { path: string; body: unknown }[] = [];
  const call: RunnerCall = async <T>(path: string, body: unknown) => {
    calls.push({ path, body });
    const r = results.shift() ?? "ok";
    if (r === "error") throw new Error("連不上資料庫");
    if (path === "checks/sql")
      return { rows: [{ stale: r === "alert" ? 2 : 0, eqm: "M01" }] } as T;
    return { ok: r === "ok", status: r === "ok" ? 200 : 500, ms: 12 } as T;
  };
  return { call, calls };
}
const due = () =>
  db.query(
    "UPDATE scheduled_checks SET next_run_at=now()-interval '1 second' WHERE status='active'",
  );
const notes = (kind: string) =>
  db.query<{ text: string }>(
    "SELECT text FROM notifications WHERE kind=$1 ORDER BY created_at,id",
    [kind],
  );
const one = () => db.one<ScheduledCheck>("SELECT * FROM scheduled_checks");

async function activeHttp(extra: Record<string, unknown> = {}) {
  const c = await createCheck(
    db,
    {
      group_id: "group-a",
      project_id: project,
      name: "機台服務",
      kind: "http",
      target: "http://10.0.0.5/health",
      interval_minutes: 15,
      ...extra,
    },
    "管理者",
  );
  return approveCheck(db, c.id, c.version, "管理者");
}

describe("排程與通知", () => {
  it("核准前不執行；核准後狀態改變才通知，異常時建立 AI 調查", async () => {
    const created = await createCheck(
      db,
      {
        group_id: "group-a",
        project_id: project,
        name: "機台服務",
        kind: "http",
        target: "http://10.0.0.5/health",
        interval_minutes: 15,
      },
      "管理者",
    );
    const r = fakeRunner(["alert", "alert", "ok"]);
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(0);
    await approveCheck(db, created.id, created.version, "管理者");
    await runDueChecks(db, r.call);
    expect((await one()).state).toBe("alert");
    expect((await notes("group_check"))[0].text).toContain("機台服務");
    expect(await notes("check")).toHaveLength(1);
    const investigation = await db.one<{ status: string; mode: string }>(
      "SELECT status,mode FROM tasks WHERE title LIKE '調查：%'",
    );
    expect(investigation).toEqual({ status: "queued", mode: "query" });
    // 持續異常不重複通知。
    await due();
    await runDueChecks(db, r.call);
    expect(await notes("group_check")).toHaveLength(1);
    // 恢復時通知一次。
    await due();
    await runDueChecks(db, r.call);
    expect((await one()).state).toBe("ok");
    expect((await notes("group_check"))[1].text).toContain("已恢復正常");
    expect(await db.query("SELECT 1 FROM scheduled_check_runs")).toHaveLength(
      3,
    );
  });
  it("檢查本身連續失敗 3 次就暫停並只通知管理者", async () => {
    await activeHttp();
    const r = fakeRunner(["error", "error", "error"]);
    for (let i = 0; i < 3; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    const c = await one();
    expect(c.status).toBe("failed");
    expect(await notes("group_check")).toHaveLength(0);
    expect((await notes("check"))[0].text).toContain("連續 3 次執行失敗");
  });
  it("靜音時段只通知管理者；每天通知有上限", async () => {
    await activeHttp({
      quiet_from: "00:00",
      quiet_to: "23:59",
      investigate: false,
    });
    const r = fakeRunner(["alert"]);
    await runDueChecks(db, r.call);
    expect(await notes("group_check")).toHaveLength(0);
    expect(await notes("check")).toHaveLength(1);
    const c = await one();
    for (let i = 0; i < dailyNoticeLimit; i++)
      await db.query(
        "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES(NULL,'check',$1,'x')",
        [`check:${c.id}:extra${i}`],
      );
    await db.query(
      "UPDATE scheduled_checks SET quiet_from=NULL,quiet_to=NULL WHERE id=$1",
      [c.id],
    );
    const again = fakeRunner(["ok"]);
    await due();
    await runDueChecks(db, again.call);
    expect(await notes("group_check")).toHaveLength(0);
    expect(
      await db.query("SELECT 1 FROM audit WHERE kind='check_capped'"),
    ).toHaveLength(1);
  });
  it("修改後要重新核准；暫停與系統暫停時不執行", async () => {
    const c = await activeHttp();
    const r = fakeRunner([]);
    await updateCheck(
      db,
      c.id,
      c.version,
      {
        group_id: "group-a",
        name: "改名",
        kind: "tcp",
        target: "10.0.0.5:502",
        daily_at: "08:00",
      },
      "管理者",
    );
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(0);
    expect((await one()).status).toBe("awaiting_approval");
    const v2 = await one();
    await approveCheck(db, v2.id, v2.version, "管理者");
    await setCheckPaused(db, v2.id, true, "管理者");
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(0);
    await setCheckPaused(db, v2.id, false, "管理者");
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{paused}','true') WHERE id=1",
    );
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(0);
  });
  it("SQL 檢查用專案登記的連線，在主機執行器上執行", async () => {
    await db.query(
      "INSERT INTO project_connections(project_id,engine,host,port,database_name,username,secret) VALUES($1,'sqlserver','db.example.test',1433,'mes','reader',$2)",
      [project, seal({ password: "fictional-password" })],
    );
    const c = await createCheck(
      db,
      {
        group_id: "group-a",
        project_id: project,
        name: "機台回報",
        kind: "sql",
        target: "SELECT COUNT(*) AS stale FROM EQM",
        condition: { column: "stale", op: ">", value: 0, listColumn: "eqm" },
        interval_minutes: 30,
        investigate: false,
      },
      "管理者",
    );
    await approveCheck(db, c.id, c.version, "管理者");
    const r = fakeRunner(["alert"]);
    await runDueChecks(db, r.call);
    expect(r.calls[0].path).toBe("checks/sql");
    expect(
      (r.calls[0].body as { connection: { host: string } }).connection.host,
    ).toBe("db.example.test");
    expect((await notes("group_check"))[0].text).toContain("stale=2：M01");
  });
});

describe("看板 API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: Awaited<ReturnType<typeof session>>;
  beforeEach(async () => {
    app = await buildApp(db);
    headers = await session();
  });
  afterEach(() => app.close());
  it("需要登入；建立後是待核准，格式錯誤時回 422", async () => {
    expect((await app.inject({ url: "/api/checks" })).statusCode).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/checks",
      headers,
      payload: {
        group_id: "group-a",
        name: "x",
        kind: "sql",
        target: "DELETE FROM t",
        project_id: project,
        interval_minutes: 60,
        condition: { column: "a", op: ">", value: 0 },
      },
    });
    expect(bad.statusCode).toBe(422);
    const ok = await app.inject({
      method: "POST",
      url: "/api/checks",
      headers,
      payload: {
        group_id: "group-a",
        name: "服務",
        kind: "tcp",
        target: "10.0.0.5:502",
        interval_minutes: 30,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("awaiting_approval");
    const list = await app.inject({ url: "/api/checks", headers });
    expect(list.json()).toHaveLength(1);
  });
});

describe("執行器的位址限制", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "host.docker.internal",
    "0.0.0.0",
  ])("拒絕 %s", async (host) => {
    const { safeHost } = await import("../server/check-probes.js");
    await expect(safeHost(host)).rejects.toThrow("不能用於定期檢查");
  });
  it("公司內網位址可以檢查", async () => {
    const { safeHost } = await import("../server/check-probes.js");
    await expect(safeHost("10.0.0.5")).resolves.toBe("10.0.0.5");
    await expect(safeHost("192.168.1.20")).resolves.toBe("192.168.1.20");
  });
  it("HTTP 檢查拒絕帶帳密或非 http 的網址", async () => {
    const { httpProbe } = await import("../server/check-probes.js");
    await expect(httpProbe("ftp://10.0.0.5/x")).rejects.toThrow();
    await expect(httpProbe("http://u:p@10.0.0.5/x")).rejects.toThrow();
  });
});
