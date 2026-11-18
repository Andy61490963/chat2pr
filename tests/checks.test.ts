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
import { AppError } from "../server/policy.js";
import {
  approveCheck,
  checkProblem,
  CheckInput,
  createCheck,
  dailyNoticeLimit,
  isHostUnavailable,
  listChecks,
  runCheck,
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
  hostRetryMinutes,
  inQuietHours,
  nextRunAt,
  parseSchedule,
  systemIssuePrefix,
  systemIssueText,
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
  it("判定欄位不存在時丟出錯誤，訊息列出可用欄位", () => {
    expect(() =>
      evaluateSql({ column: "stale", op: ">", value: 0 }, [
        { stale_count: 3, eqm: "M01" },
      ]),
    ).toThrow(
      "查詢結果沒有欄位「stale」，可用欄位：stale_count、eqm（請修改判定欄位或 SELECT 別名）",
    );
    // 大小寫不同但有兩個候選時無法判斷，也算找不到。
    expect(() =>
      evaluateSql({ column: "stale", op: ">", value: 0 }, [
        { STALE: 1, Stale: 2 },
      ]),
    ).toThrow("可用欄位：STALE、Stale");
  });
  it("判定欄位只差大小寫時照樣判定", () => {
    expect(
      evaluateSql({ column: "stale", op: ">", value: 0 }, [{ STALE: 2 }]),
    ).toEqual({ alert: true, summary: "stale=2" });
    expect(
      evaluateSql({ column: "stale", op: ">", value: 0 }, [{ STALE: 0 }]).alert,
    ).toBe(false);
    // 精確符合優先於不分大小寫的候選。
    expect(
      evaluateSql({ column: "stale", op: ">", value: 0 }, [
        { stale: 0, STALE: 5 },
      ]).alert,
    ).toBe(false);
  });
  it("查詢沒有回傳資料時維持「（無資料）」，不丟錯誤", () => {
    expect(
      evaluateSql(
        { column: "stale", op: ">", value: 0, listColumn: "eqm" },
        [],
      ),
    ).toEqual({ alert: false, summary: "stale=（無資料）" });
  });
  it("列出欄位找不到時不丟錯誤，摘要加上提示；只差大小寫時照樣列出", () => {
    expect(
      evaluateSql({ column: "stale", op: ">", value: 0, listColumn: "eqm" }, [
        { stale: 1, machine: "M01" },
      ]),
    ).toEqual({
      alert: true,
      summary: "stale=1（找不到列出欄位「eqm」）",
    });
    expect(
      evaluateSql({ column: "stale", op: ">", value: 0, listColumn: "eqm" }, [
        { stale: 1, EQM: "M01" },
      ]).summary,
    ).toBe("stale=1：M01");
  });
  it("系統暫時無法執行的分類與重試間隔", () => {
    expect(
      isHostUnavailable(new AppError(503, "檢查環境建立失敗，請稍後再試")),
    ).toBe(true);
    expect(
      isHostUnavailable(new AppError(502, "執行器回應不是完整的 JSON")),
    ).toBe(true);
    expect(
      isHostUnavailable(
        new Error(
          "執行器連線失敗（ECONNREFUSED）；請檢查執行器、網路及逾時紀錄",
        ),
      ),
    ).toBe(true);
    expect(isHostUnavailable(new AppError(504, "檢查執行逾時"))).toBe(false);
    expect(isHostUnavailable(new AppError(500, "連不上資料庫"))).toBe(false);
    expect(isHostUnavailable(new AppError(409, "專案沒有登記資料庫連線"))).toBe(
      false,
    );
    expect(isHostUnavailable(new Error("連不上資料庫"))).toBe(false);
    expect([1, 2, 3, 4, 9].map(hostRetryMinutes)).toEqual([5, 15, 30, 60, 60]);
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
function fakeRunner(results: ("ok" | "alert" | "error" | Error)[]) {
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
    if (r instanceof Error) throw r;
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
  const gapMinutes = (c: ScheduledCheck) =>
    (new Date(c.next_run_at!).getTime() - new Date(c.last_run_at!).getTime()) /
    60000;
  it.each([
    [
      "檢查環境建立失敗（503）",
      () => new AppError(503, "檢查環境建立失敗，請稍後再試"),
    ],
    [
      "執行器連線失敗",
      () =>
        new Error(
          "執行器連線失敗（ECONNREFUSED）；請檢查執行器、網路及逾時紀錄",
        ),
    ],
  ])(
    "系統暫時無法執行（%s）不計入連續失敗，依退避延後重試",
    async (_, error) => {
      await activeHttp({ interval_minutes: 120 });
      const r = fakeRunner(Array.from({ length: 5 }, error));
      const gaps: number[] = [];
      for (let i = 0; i < 5; i++) {
        await due();
        await runDueChecks(db, r.call);
        const c = await one();
        expect(c.status).toBe("active");
        expect(c.consecutive_errors).toBe(0);
        expect(c.next_run_at).not.toBeNull();
        gaps.push(gapMinutes(c));
      }
      expect(gaps).toEqual([5, 15, 30, 60, 60]);
      const runs = await db.query<{ outcome: string; summary: string }>(
        "SELECT outcome,summary FROM scheduled_check_runs ORDER BY id",
      );
      expect(runs).toHaveLength(5);
      expect(runs[0].outcome).toBe("error");
      expect(runs[0].summary).toMatch(/^系統暫時無法執行（不計入連續失敗）：/);
      expect(await notes("check")).toHaveLength(0);
      // 主機恢復後照常執行，退避從頭算。
      await due();
      await runDueChecks(db, r.call);
      expect(gapMinutes(await one())).toBe(120);
    },
  );
  it("退避不晚於原本的下次排程；系統問題不歸零檢查本身的連續失敗", async () => {
    await activeHttp();
    const r = fakeRunner([
      "error",
      "error",
      new AppError(503, "檢查環境啟動逾時"),
      new AppError(503, "檢查環境啟動逾時"),
    ]);
    for (let i = 0; i < 4; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    const c = await one();
    expect(c.status).toBe("active");
    expect(c.consecutive_errors).toBe(2);
    // 第 2 次系統問題的退避是 15 分鐘，和 15 分鐘的間隔取較早者。
    expect(gapMinutes(c)).toBe(15);
  });
  it.each([
    ["500", () => new AppError(500, "連不上資料庫")],
    ["504", () => new AppError(504, "檢查執行逾時")],
  ])("檢查本身的錯誤（%s）連續 3 次仍暫停", async (_, error) => {
    await activeHttp();
    const r = fakeRunner(Array.from({ length: 3 }, error));
    for (let i = 0; i < 3; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    const c = await one();
    expect(c.status).toBe("failed");
    expect(c.next_run_at).toBeNull();
  });
  it("系統問題持續超過 6 小時寫一次稽核並在清單標示開始時間，但不暫停", async () => {
    await activeHttp({ interval_minutes: 120 });
    const r = fakeRunner(
      Array.from({ length: 4 }, () => new AppError(503, "檢查環境已停止")),
    );
    const t0 = new Date("2026-11-14T00:00:00Z");
    for (const hours of [0, 5, 7, 8])
      await runCheck(
        db,
        r.call,
        await one(),
        new Date(t0.getTime() + hours * 3600000),
      );
    const audits = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='check_host_unavailable'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toContain("已超過 6 小時因系統問題無法執行");
    const [listed] = await listChecks(db);
    expect(listed.host_unavailable_since).toBe(t0.toISOString());
    expect(listed.status).toBe("active");
    // 一次正常執行後就不再標示。
    await runCheck(db, fakeRunner(["ok"]).call, await one());
    expect((await listChecks(db))[0].host_unavailable_since).toBeNull();
  });
  const imageMissing = () =>
    new AppError(
      503,
      systemIssueText.imageMissing("line-agentflow-check:local"),
    );
  it("系統設定問題（找不到定期檢查映像）：不計入連續失敗、至少 6 小時後重試、只通知管理者一次", async () => {
    await activeHttp();
    const r = fakeRunner(["error", imageMissing(), imageMissing()]);
    for (let i = 0; i < 3; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    const c = await one();
    expect(c.status).toBe("active");
    // 第一次是檢查本身的錯誤；之後的系統設定問題不增加也不歸零。
    expect(c.consecutive_errors).toBe(1);
    // 15 分鐘的間隔拉長到 6 小時。
    expect(gapMinutes(c)).toBe(6 * 60);
    const runs = await db.query<{ outcome: string; summary: string }>(
      "SELECT outcome,summary FROM scheduled_check_runs ORDER BY id",
    );
    expect(runs.map((x) => x.outcome)).toEqual(["error", "error", "error"]);
    expect(runs[1].summary.startsWith(systemIssuePrefix)).toBe(true);
    const admin = await notes("check");
    expect(admin).toHaveLength(1);
    expect(admin[0].text).toContain("定期檢查因系統設定問題暫停執行");
    expect(admin[0].text).toContain("npm run deploy");
    expect(await notes("group_check")).toHaveLength(0);
    const audits = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='check_system_issue'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toContain("npm run deploy");
    const [listed] = await listChecks(db);
    expect(listed.system_issue?.kind).toBe("image_missing");
    expect(listed.host_unavailable_since).toBeNull();
    // 問題排除後正常執行，標示消失、間隔恢復。
    await due();
    await runDueChecks(db, fakeRunner(["ok"]).call);
    expect((await listChecks(db))[0].system_issue).toBeNull();
    expect(gapMinutes(await one())).toBe(15);
  });
  it("多個檢查同時遇到同一個系統設定問題，只產生一則管理者通知", async () => {
    for (const name of ["機台服務甲", "機台服務乙", "機台服務丙"])
      await activeHttp({ name });
    const r = fakeRunner(Array.from({ length: 6 }, imageMissing));
    await runDueChecks(db, r.call);
    expect(r.calls).toHaveLength(3);
    const checks = await db.query<ScheduledCheck>(
      "SELECT * FROM scheduled_checks",
    );
    for (const c of checks) {
      expect(c.status).toBe("active");
      expect(c.consecutive_errors).toBe(0);
      expect(gapMinutes(c)).toBe(6 * 60);
    }
    expect(await notes("check")).toHaveLength(1);
    // 同一天再遇到也不重發。
    await due();
    await runDueChecks(db, r.call);
    expect(await notes("check")).toHaveLength(1);
    expect(
      await db.query("SELECT 1 FROM audit WHERE kind='check_system_issue'"),
    ).toHaveLength(1);
  });
  it("24 小時內第二次轉為異常：不再承諾回報，也不重複建立調查", async () => {
    await activeHttp();
    const r = fakeRunner(["alert", "ok", "alert"]);
    for (let i = 0; i < 3; i++) {
      await due();
      await runDueChecks(db, r.call);
    }
    const texts = (await notes("group_check")).map((n) => n.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("AI 正在調查可能原因，結果會再回報。");
    expect(texts[2]).not.toContain("結果會再回報");
    expect(texts[2]).toContain("今天稍早已調查過這項檢查，這次不重複調查。");
    expect((await notes("check")).at(-1)?.text).toBe(texts[2]);
    expect(
      await db.query("SELECT 1 FROM tasks WHERE title LIKE '調查：%'"),
    ).toHaveLength(1);
  });
  it("專案未驗證時異常通知不提調查，也不建立調查任務", async () => {
    await db.query("UPDATE projects SET validated_at=NULL WHERE id=$1", [
      project,
    ]);
    await activeHttp();
    await runDueChecks(db, fakeRunner(["alert"]).call);
    const [text] = (await notes("group_check")).map((n) => n.text);
    expect(text).toContain("機台服務");
    expect(text).not.toContain("AI 正在調查");
    expect(text).not.toContain("調查過");
    expect(
      await db.query("SELECT 1 FROM tasks WHERE title LIKE '調查：%'"),
    ).toHaveLength(0);
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

describe("看板 API：試跑與資料庫連線", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: Awaited<ReturnType<typeof session>>;
  let runner: RunnerCall;
  /** 執行器：檢查一律回傳指定的結果。 */
  const returning =
    (result: unknown): RunnerCall =>
    async <T>(path: string) => {
      if (path === "checks/run")
        return { result, environment: { created: false } } as T;
      if (path === "checks/environments")
        return { environments: [], failures: [] } as T;
      return { removed: [] } as T;
    };
  beforeEach(async () => {
    runner = returning({ rows: [] });
    app = await buildApp(db, undefined, undefined, undefined, {
      call: <T>(path: string, body: unknown, timeoutMs?: number) =>
        runner<T>(path, body, timeoutMs),
    });
    headers = await session();
  });
  afterEach(() => app.close());
  const connect = () =>
    db.query(
      "INSERT INTO project_connections(project_id,engine,host,port,database_name,username,secret) VALUES($1,'sqlserver','db.example.test',1433,'mes','reader',$2)",
      [project, seal({ password: "fictional-password" })],
    );
  const sqlCheck = (condition: Record<string, unknown> = {}) =>
    createCheck(
      db,
      {
        group_id: "group-a",
        project_id: project,
        name: "機台回報",
        kind: "sql",
        target: "SELECT COUNT(*) AS stale FROM EQM",
        condition: { column: "stale", op: ">", value: 0, ...condition },
        interval_minutes: 30,
        investigate: false,
      },
      "管理者",
    );
  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers, payload });

  it("試跑回傳結果與已遮罩的摘要，不寫入執行紀錄", async () => {
    const c = await activeHttp();
    runner = returning({
      ok: false,
      status: 0,
      ms: 5,
      error: "連線被拒（sk-fictional-key-1234567890）",
    });
    const res = await post(`/api/checks/${c.id}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: "alert",
      summary: "HTTP 連線被拒（[已遮蔽金鑰]）",
    });
    expect(await db.query("SELECT 1 FROM scheduled_check_runs")).toHaveLength(
      0,
    );
  });

  it("試跑時判定欄位不存在：結果是執行失敗並列出可用欄位", async () => {
    await connect();
    const c = await sqlCheck();
    runner = returning({ rows: [{ STALE_COUNT: 3, eqm: "M01" }] });
    const res = await post(`/api/checks/${c.id}/test`);
    expect(res.json().outcome).toBe("error");
    expect(res.json().summary).toContain("可用欄位：STALE_COUNT、eqm");
    expect(await db.query("SELECT 1 FROM scheduled_check_runs")).toHaveLength(
      0,
    );
  });

  it("沒有資料庫連線的 SQL 檢查：可以建立與試跑，但核准、恢復回 409；登記連線後可核准", async () => {
    const c = await sqlCheck();
    const listed = (await app.inject({ url: "/api/checks", headers })).json();
    expect(listed[0]).toMatchObject({
      missing_connection: true,
      host_unavailable_since: null,
    });
    const test = await post(`/api/checks/${c.id}/test`);
    expect(test.json()).toMatchObject({ outcome: "error" });
    const approve = await post(`/api/checks/${c.id}/approve`, {
      version: c.version,
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error ?? approve.body).toContain(
      "這個專案還沒有登記資料庫連線",
    );
    expect((await one()).status).toBe("awaiting_approval");

    await connect();
    expect(
      (await app.inject({ url: "/api/checks", headers })).json()[0]
        .missing_connection,
    ).toBe(false);
    const ok = await post(`/api/checks/${c.id}/approve`, {
      version: c.version,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("active");

    // 核准後連線被刪除：暫停後不能恢復。
    expect((await post(`/api/checks/${c.id}/pause`)).statusCode).toBe(200);
    await db.query("DELETE FROM project_connections WHERE project_id=$1", [
      project,
    ]);
    const resume = await post(`/api/checks/${c.id}/resume`);
    expect(resume.statusCode).toBe(409);
    expect(resume.body).toContain("資料庫連線");
    expect((await one()).status).toBe("paused");
  });

  it("沒有執行器時清單也標示缺少連線；HTTP 檢查不受影響", async () => {
    await sqlCheck();
    await activeHttp();
    const rows = await listChecks(db);
    expect(
      Object.fromEntries(rows.map((r) => [r.kind, r.missing_connection])),
    ).toEqual({ sql: true, http: false });
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
