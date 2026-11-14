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
  syncCheckEnvironments,
  updateCheck,
  validCheckEnvironments,
  type RunnerCall,
} from "../server/checks.js";
import {
  asksForSchedule,
  assertReadOnlySelect,
  evaluateSql,
  inQuietHours,
  nextRunAt,
  parseSchedule,
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

/**
 * 模擬執行器：依序回傳指定結果；error 表示執行失敗。
 * 環境以 checkId＋環境鍵記住，鍵相同就算重用（created=false）；calls 只記錄檢查執行。
 */
function fakeRunner(results: ("ok" | "alert" | "error")[]) {
  const calls: { path: string; body: unknown }[] = [];
  const syncs: { valid: { checkId: string; key: string }[] }[] = [];
  const kept = new Map<string, string>();
  const call: RunnerCall = async <T>(path: string, body: unknown) => {
    const b = body as Record<string, unknown>;
    if (path === "checks/environments/sync") {
      syncs.push(b as (typeof syncs)[number]);
      const valid = new Map(
        (b.valid as { checkId: string; key: string }[]).map((v) => [
          v.checkId,
          v.key,
        ]),
      );
      const removed = [...kept]
        .filter(([id, key]) => valid.get(id) !== key)
        .map(([checkId]) => ({ checkId, reason: "stale" }));
      for (const r of removed) kept.delete(r.checkId);
      return { removed } as T;
    }
    if (path === "checks/environments")
      return {
        environments: [...kept].map(([checkId, key]) => ({
          checkId,
          key,
          createdAt: "2026-11-14T00:00:00.000Z",
          lastUsedAt: "2026-11-14T01:00:00.000Z",
        })),
        failures: [],
      } as T;
    if (path === "checks/environments/remove") {
      const existed = kept.delete(b.checkId as string);
      return { removed: existed } as T;
    }
    calls.push({ path, body });
    const created = kept.get(b.checkId as string) !== b.key;
    kept.set(b.checkId as string, b.key as string);
    const r = results.shift() ?? "ok";
    if (r === "error") throw new Error("連不上資料庫");
    const result =
      b.kind === "sql"
        ? { rows: [{ stale: r === "alert" ? 2 : 0, eqm: "M01" }] }
        : { ok: r === "ok", status: r === "ok" ? 200 : 500, ms: 12 };
    return { result, environment: { created } } as T;
  };
  return { call, calls, syncs, kept };
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
  it("SQL 檢查用專案登記的連線，在該檢查的專用環境執行", async () => {
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
    expect(r.calls[0].path).toBe("checks/run");
    expect(r.calls[0].body).toMatchObject({
      checkId: c.id,
      kind: "sql",
      sql: "SELECT COUNT(*) AS stale FROM EQM",
      connection: { host: "db.example.test" },
      policy: { idleMinutes: 120, max: 20 },
    });
    expect((await notes("group_check"))[0].text).toContain("stale=2：M01");
  });
});

describe("檢查環境的保留與清除（#19）", () => {
  const connect = () =>
    db.query(
      "INSERT INTO project_connections(project_id,engine,host,port,database_name,username,secret,updated_at) VALUES($1,'sqlserver','db.example.test',1433,'mes','reader',$2,'2026-11-01T00:00:00Z')",
      [project, seal({ password: "fictional-password" })],
    );
  async function activeSql() {
    const c = await createCheck(
      db,
      {
        group_id: "group-a",
        project_id: project,
        name: "機台回報",
        kind: "sql",
        target: "SELECT COUNT(*) AS stale FROM EQM",
        condition: { column: "stale", op: ">", value: 0 },
        interval_minutes: 30,
        investigate: false,
      },
      "管理者",
    );
    return approveCheck(db, c.id, c.version, "管理者");
  }
  const keyOf = async (id: string) =>
    (await validCheckEnvironments(db)).find((v) => v.checkId === id)?.key;
  const envAudits = () =>
    db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='check_environment' ORDER BY created_at,id",
    );

  it("同一個檢查連續兩次執行，第二次重用同一個環境、只記一次建立", async () => {
    await connect();
    const c = await activeSql();
    const r = fakeRunner(["ok", "ok"]);
    await runDueChecks(db, r.call);
    await due();
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(2);
    const keys = r.calls.map((x) => (x.body as { key: string }).key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(await keyOf(c.id));
    expect((await envAudits()).map((a) => a.detail)).toEqual([
      "定期檢查「機台回報」建立檢查環境（第 1 版）",
    ]);
  });

  it("環境鍵：檢查修改、連線更新、記下 SSH 主機金鑰都會換新環境", async () => {
    await connect();
    const c = await activeSql();
    const first = await keyOf(c.id);
    await db.query(
      "UPDATE project_connections SET updated_at='2026-11-02T00:00:00Z' WHERE project_id=$1",
      [project],
    );
    const second = await keyOf(c.id);
    expect(second).not.toBe(first);
    await db.query(
      "UPDATE project_connections SET ssh_host='jump.example.test',ssh_port=22,ssh_username='u',ssh_host_key='SHA256:fictional' WHERE project_id=$1",
      [project],
    );
    const third = await keyOf(c.id);
    expect(third).not.toBe(second);
    await updateCheck(
      db,
      c.id,
      c.version,
      {
        group_id: "group-a",
        project_id: project,
        name: "機台回報",
        kind: "sql",
        target: "SELECT COUNT(*) AS stale FROM EQM WHERE 1=1",
        condition: { column: "stale", op: ">", value: 0 },
        interval_minutes: 30,
      },
      "管理者",
    );
    // 待核准仍可試跑，所以保留在有效清單，但鍵已不同。
    const fourth = await keyOf(c.id);
    expect(fourth).toBeDefined();
    expect(fourth).not.toBe(third);
  });

  it("暫停、因錯誤停用、刪除、連線刪除、群組或專案停用、解除綁定、系統暫停：都不在有效清單", async () => {
    await connect();
    const c = await activeSql();
    const http = await activeHttp();
    expect(await keyOf(c.id)).toBeDefined();
    const toggles: [string, string, string][] = [
      [
        "UPDATE scheduled_checks SET status='paused' WHERE id=$1",
        "UPDATE scheduled_checks SET status='active' WHERE id=$1",
        c.id,
      ],
      [
        "UPDATE scheduled_checks SET status='failed' WHERE id=$1",
        "UPDATE scheduled_checks SET status='active' WHERE id=$1",
        c.id,
      ],
      [
        "UPDATE groups SET enabled=false WHERE id='group-a' AND $1::text IS NOT NULL",
        "UPDATE groups SET enabled=true WHERE id='group-a' AND $1::text IS NOT NULL",
        c.id,
      ],
      [
        "UPDATE projects SET enabled=false WHERE id=$1",
        "UPDATE projects SET enabled=true WHERE id=$1",
        project,
      ],
      [
        "UPDATE settings SET value=jsonb_set(value,'{paused}','true') WHERE id=1 AND $1::text IS NOT NULL",
        "UPDATE settings SET value=jsonb_set(value,'{paused}','false') WHERE id=1 AND $1::text IS NOT NULL",
        c.id,
      ],
    ];
    for (const [off, on, arg] of toggles) {
      await db.query(off, [arg]);
      expect(await keyOf(c.id), off).toBeUndefined();
      await db.query(on, [arg]);
      expect(await keyOf(c.id), on).toBeDefined();
    }
    await db.query("DELETE FROM project_connections WHERE project_id=$1", [
      project,
    ]);
    expect(await keyOf(c.id)).toBeUndefined();
    // 沒有連線的需求只影響 SQL 檢查。
    expect(await keyOf(http.id)).toBeDefined();
    await db.query("DELETE FROM group_projects WHERE project_id=$1", [project]);
    expect(await keyOf(http.id)).toBeUndefined();
  });

  it("同步：清單外的環境被清除並寫稽核；檢查連續錯誤暫停後立即清除", async () => {
    const c = await activeHttp();
    const r = fakeRunner(["error", "error", "error"]);
    for (let i = 0; i < 2; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    expect(r.kept.has(c.id)).toBe(true);
    await due();
    await runDueChecks(db, r.call);
    expect((await one()).status).toBe("failed");
    expect(r.kept.has(c.id)).toBe(false);
    expect((await envAudits()).at(-1)?.detail).toContain(
      "清除定期檢查「機台服務」的檢查環境",
    );
    // 已刪除的檢查也照樣寫稽核。
    r.kept.set("0b3a2d6e-1f00-4c1a-9a00-0000000000ff", "v1");
    expect(await syncCheckEnvironments(db, r.call)).toEqual([
      { checkId: "0b3a2d6e-1f00-4c1a-9a00-0000000000ff", reason: "stale" },
    ]);
    expect((await envAudits()).at(-1)?.detail).toContain("已刪除定期檢查");
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

describe("看板 API：檢查環境（#19）", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: Awaited<ReturnType<typeof session>>;
  let r: ReturnType<typeof fakeRunner>;
  beforeEach(async () => {
    r = fakeRunner([]);
    app = await buildApp(db, undefined, undefined, undefined, {
      call: r.call,
    });
    headers = await session();
  });
  afterEach(() => app.close());

  it("顯示環境狀態與預計清除時間；修改或暫停後立即清除；可手動清除並寫稽核", async () => {
    const c = await activeHttp();
    await runDueChecks(db, r.call);
    const listed = (await app.inject({ url: "/api/checks", headers })).json();
    expect(listed[0].environment).toEqual({
      state: "kept",
      createdAt: "2026-11-14T00:00:00.000Z",
      lastUsedAt: "2026-11-14T01:00:00.000Z",
      expiresAt: "2026-11-14T03:00:00.000Z",
    });
    const paused = await app.inject({
      method: "POST",
      url: `/api/checks/${c.id}/pause`,
      headers,
    });
    expect(paused.statusCode).toBe(200);
    await vi.waitFor(() => expect(r.kept.has(c.id)).toBe(false));
    expect(
      (await app.inject({ url: "/api/checks", headers })).json()[0].environment,
    ).toEqual({ state: "none" });
    // 手動清除。
    await app.inject({
      method: "POST",
      url: `/api/checks/${c.id}/resume`,
      headers,
    });
    await r.call("checks/run", {
      checkId: c.id,
      key: "v1",
      kind: "http",
    });
    const cleared = await app.inject({
      method: "POST",
      url: `/api/checks/${c.id}/environment/clear`,
      headers,
    });
    expect(cleared.json()).toEqual({ removed: true });
    expect(
      await db.query(
        "SELECT 1 FROM audit WHERE kind='check_environment' AND detail LIKE '%管理者手動清除%'",
      ),
    ).toHaveLength(1);
  });

  it("系統頁可以調整閒置時間與保留數上限，範圍外拒絕", async () => {
    const save = (body: unknown) =>
      app.inject({
        method: "PUT",
        url: "/api/settings/check-environments",
        headers,
        payload: body as Record<string, unknown>,
      });
    expect((await save({ idleMinutes: 5, max: 20 })).statusCode).toBe(400);
    expect((await save({ idleMinutes: 30, max: 5 })).statusCode).toBe(200);
    const s = (
      await app.inject({ url: "/api/check-environments/settings", headers })
    ).json();
    expect(s).toMatchObject({ idleMinutes: 30, max: 5 });
    // 設定改變後立即送給執行器套用。
    await vi.waitFor(() =>
      expect(r.syncs.at(-1)).toMatchObject({
        policy: { idleMinutes: 30, max: 5 },
      }),
    );
  });

  it("連線更新後立即同步，舊環境（舊機密）被清除", async () => {
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
        condition: { column: "stale", op: ">", value: 0 },
        interval_minutes: 30,
        investigate: false,
      },
      "管理者",
    );
    await approveCheck(db, c.id, c.version, "管理者");
    await runDueChecks(db, r.call);
    expect(r.kept.has(c.id)).toBe(true);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/projects/${project}/database`,
      headers,
      payload: {
        engine: "sqlserver",
        host: "db2.example.test",
        port: 1433,
        database: "mes",
        username: "reader",
        password: "another-fictional-password",
      },
    });
    expect(saved.statusCode).toBe(200);
    await vi.waitFor(() => expect(r.kept.has(c.id)).toBe(false));
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
    const { httpTarget, httpEndpoint } =
      await import("../server/check-probes.js");
    expect(() => httpTarget("ftp://10.0.0.5/x")).toThrow();
    expect(() => httpTarget("http://u:p@10.0.0.5/x")).toThrow();
    // 轉接器的目標：網址的主機與連接埠（預設 80／443）。
    expect(httpEndpoint("https://10.0.0.5/health")).toEqual({
      host: "10.0.0.5",
      port: 443,
    });
    expect(httpEndpoint("http://[fd00::5]:8080/x")).toEqual({
      host: "fd00::5",
      port: 8080,
    });
  });
});

describe("從回答讀出排程", () => {
  const every = (intervalMinutes: number) => ({
    intervalMinutes,
    dailyAt: null,
  });
  const daily = (dailyAt: string) => ({ intervalMinutes: null, dailyAt });
  it.each([
    ["每 15 分鐘查一次", every(15)],
    ["每隔30分鐘", every(30)],
    ["每十五分鐘", every(15)],
    ["每半小時", every(30)],
    ["每小時", every(60)],
    ["每個小時檢查", every(60)],
    ["每兩小時", every(120)],
    ["每 3 個小時", every(180)],
    ["每天 08:30", daily("08:30")],
    ["每天早上八點", daily("08:00")],
    ["每天下午三點半", daily("15:30")],
    ["每日晚上 9 點 15 分", daily("21:15")],
    ["每 5 分鐘", null],
    ["盡快", null],
    ["每天下午", null],
  ])("%s", (text, expected) => {
    expect(parseSchedule(text)).toEqual(expected);
  });
  it("只把問頻率的補問當成排程問題", () => {
    expect(asksForSchedule("希望多久檢查一次？")).toBe(true);
    expect(asksForSchedule("每天幾點檢查？")).toBe(true);
    expect(asksForSchedule("要監看哪個專案？")).toBe(false);
  });
});
