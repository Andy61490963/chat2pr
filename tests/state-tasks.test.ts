import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-secret",
    githubWebhookSecret: "fictional-github",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import type { StateTotals, Task, TaskPage } from "../shared/types.js";

beforeEach(reset);
afterAll(() => db.close());

type StateBody = { tasks: Task[]; totals: StateTotals };

async function state(query = "") {
  const headers = await session(),
    app = await buildApp(db);
  try {
    const r = await app.inject({ url: `/api/state${query}`, headers });
    expect(r.statusCode).toBe(200);
    return r.json() as StateBody;
  } finally {
    await app.close();
  }
}

describe("/api/state 完整載入待處理任務", () => {
  it("較舊的失敗任務被 260 筆較新的已合併任務擠出最近 250 筆後仍在清單中", async () => {
    const project = await fixture();
    // 最舊一筆失敗，其餘 259 筆較新且已合併。
    await db.query(
      `INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key,created_at,updated_at)
       SELECT $1,'group-a','虛構需求 '||i,'摘要',CASE WHEN i=0 THEN 'failed' ELSE 'merged' END,'state-load-'||i,
         now()-interval '30 days'+i*interval '1 minute',now()-interval '30 days'+i*interval '1 minute'
       FROM generate_series(0,259) i`,
      [project],
    );
    const body = await state();
    const failed = body.tasks.filter((t) => t.status === "failed");
    expect(failed.map((t) => t.title)).toEqual(["虛構需求 0"]);
    // 最近 250 筆加上那一筆失敗的。
    expect(body.tasks).toHaveLength(251);
    expect(body.totals.tasks).toBe(260);
    expect(body.totals.byStatus.failed).toBe(1);
    expect(body.totals.byStatus.merged).toBe(259);
    expect(body.totals.unfinishedOmitted).toBe(0);
    // 清單依更新時間由新到舊。
    const times = body.tasks.map((t) => new Date(t.updated_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("近 7 天合併數以臺北時間計，不受清單載入範圍影響", async () => {
    const project = await fixture();
    await db.query(
      `INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key,updated_at) VALUES
        ($1,'group-a','本週合併','摘要','merged','week-1',now()),
        ($1,'group-a','三天前合併','摘要','merged','week-2',now()-interval '3 days'),
        ($1,'group-a','上個月合併','摘要','merged','week-3',now()-interval '30 days')`,
      [project],
    );
    const body = await state("?tasks=1");
    expect(body.tasks).toHaveLength(1);
    expect(body.totals.mergedWeek).toBe(2);
    expect(body.totals.byStatus.merged).toBe(3);
  });

  it("執行中的任務帶目前階段與期限；沒有執行或執行已結束的任務這些欄位為 null", async () => {
    const project = await fixture();
    const insert = (title: string, status: string) =>
      db.one<{ id: string }>(
        "INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key) VALUES($1,'group-a',$2,'摘要',$3,$2) RETURNING id",
        [project, title, status],
      );
    const running = await insert("執行中", "running");
    const queued = await insert("排隊中", "queued");
    const finished = await insert("已失敗", "failed");
    await db.query(
      "INSERT INTO runs(task_id,version,model,status,deadline,started_at,completed_at) VALUES($1,1,'fictional-model','code',now()+interval '30 minutes',now()-interval '5 minutes',NULL)",
      [running.id],
    );
    await db.query(
      "INSERT INTO runs(task_id,version,model,status,deadline,started_at,completed_at) VALUES($1,1,'fictional-model','test',now(),now()-interval '1 hour',now()-interval '30 minutes')",
      [finished.id],
    );
    const body = await state();
    const byId = new Map(body.tasks.map((t) => [t.id, t]));
    const live = byId.get(running.id)!;
    expect(live.run_phase).toBe("code");
    expect(live.run_deadline).toBeTruthy();
    expect(live.run_started_at).toBeTruthy();
    expect(live.run_heartbeat_at).toBeTruthy();
    for (const id of [queued.id, finished.id]) {
      const t = byId.get(id)!;
      expect(t.run_phase).toBeNull();
      expect(t.run_started_at).toBeNull();
      expect(t.run_deadline).toBeNull();
      expect(t.run_heartbeat_at).toBeNull();
    }
    // 只帶四欄，不夾帶 runs 的其他欄位（例如 token_hash、workspace）。
    expect(Object.keys(live)).not.toContain("token_hash");
    expect(Object.keys(live)).not.toContain("workspace");
    expect(body.totals.byStatus).toMatchObject({
      running: 1,
      queued: 1,
      failed: 1,
    });
  });
});

it("任務清單先篩選再分批，相同更新時間也不會漏列或重複", async () => {
  const project = await fixture();
  const archived = await db.query<Pick<Task, "id">>(
    `INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key,updated_at)
     SELECT $1,'group-a','範例歷史任務 '||i,'列印清單','merged','archive-demo-'||i,
       '2026-01-01T01:00:00.123456Z'::timestamptz
     FROM generate_series(1,34) i RETURNING id`,
    [project],
  );
  await db.query(
    `INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key,updated_at) VALUES
      ($1,'group-a','範例待執行任務','列印清單','queued','queued-demo','2026-01-03T01:00:00Z'),
      ($1,'group-a','範例歷史任務','更新圖示','closed','closed-demo','2026-01-02T01:00:00Z'),
      (NULL,'group-a','範例未指定專案','列印清單','answered','no-project-demo','2026-01-02T01:00:00Z')`,
    [project],
  );
  const app = await buildApp(db);
  try {
    expect((await app.inject("/api/tasks?filter=all")).statusCode).toBe(401);
    const headers = await session();
    const list = async (params: Record<string, string>) => {
      const response = await app.inject({
        url: `/api/tasks?${new URLSearchParams(params)}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      return response.json<TaskPage>();
    };
    const filters = {
      filter: "closed",
      project,
      group: "group-a",
      q: "列印清單",
    };
    const expected = archived
      .map(({ id }) => id)
      .sort()
      .reverse();
    const first = await list(filters);
    expect(first.tasks.map(({ id }) => id)).toEqual(expected.slice(0, 30));
    expect(first.next).toEqual({
      before: "2026-01-01T01:00:00.123456Z",
      beforeId: expected[29],
    });
    const last = await list({ ...filters, ...first.next! });
    expect(last.tasks.map(({ id }) => id)).toEqual(expected.slice(30));
    expect(last.next).toBeNull();
    expect((await list({ filter: "all" })).tasks[0].title).toBe(
      "範例待執行任務",
    );
    expect(
      (await list({ filter: "closed", project: "none" })).tasks.map(
        ({ title }) => title,
      ),
    ).toEqual(["範例未指定專案"]);
  } finally {
    await app.close();
  }
});
