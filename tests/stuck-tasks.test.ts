import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { prepareDigest } from "../server/line-private.js";
import { checkStuckTasks } from "../server/stuck-tasks.js";
import { confirmTask, db, fixture, reset, session } from "./helpers.js";
import type { TaskStatus } from "../shared/types.js";

const origin = Date.now();
const at = (minutes: number) => new Date(origin + minutes * 60_000);
let project: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Awaited<ReturnType<typeof session>>;

const scan = (minutes: number) => checkStuckTasks(db, at(minutes));

async function inboxState() {
  const response = await app.inject({ url: "/api/state?tasks=1", headers });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function inbox() {
  return (await inboxState()).stuckTasks;
}

async function task(status: TaskStatus, title = "示範任務", minutes = 0) {
  const row = await db.one<{ id: string }>(
    `INSERT INTO tasks(group_id,project_id,title,summary,status,dedupe_key,updated_at,created_at)
     VALUES('group-a',$1,$2,'示範需求',$3,$4,$5,$5) RETURNING id`,
    [project, title, status, randomUUID(), at(minutes)],
  );
  if (status === "queued") {
    await db.query("UPDATE tasks SET approved_version=version,mode='query' WHERE id=$1", [row.id]);
    await confirmTask(row.id);
  }
  return row.id;
}

async function run(taskId: string, minute: number, outcome: string | null, detail?: string) {
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO runs(task_id,version,model,started_at,heartbeat_at,deadline,completed_at,outcome,status)
     VALUES($1,1,'示範模型',$2,$2,$3,$4,$5,'code') RETURNING id`,
    [taskId, at(minute), at(minute + 30), outcome ? at(minute + 1) : null, outcome],
  );
  if (detail)
    await db.query(
      `INSERT INTO run_events(run_id,source,seq,at,phase,kind,detail,exit_code)
       VALUES($1,'runner',1,$2,'code','phase_end',$3,1)`, [id, at(minute), detail],
    );
  return id;
}

async function health(name: string, ok: boolean) {
  await db.query(
    `INSERT INTO service_health(name,ok,detail,checked_at) VALUES($1,$2,'示範讀數',$3)
     ON CONFLICT(name) DO UPDATE SET ok=excluded.ok,checked_at=excluded.checked_at`,
    [name, ok, at(0)],
  );
}

beforeAll(async () => { app = await buildApp(db); });
beforeEach(async () => {
  await reset();
  await db.query("DELETE FROM service_health WHERE name IN ('host_resources','runner')");
  project = await fixture();
  headers = await session();
});
afterAll(async () => { await app.close(); await db.close(); });

describe("卡住任務的收件匣與管理者通知", () => {
  it("登入才可讀取，沒有卡住的任務時回傳空清單", async () => {
    expect((await app.inject({ url: "/api/state" })).statusCode).toBe(401);
    expect(await inboxState()).toMatchObject({ stuckTasks: [], stuckTasksTotal: 0 });
  });

  it("先列最久卡住的二十筆，總數包含未列出的任務但不含已解除的任務", async () => {
    await db.query(
      `INSERT INTO tasks(group_id,project_id,title,summary,status,dedupe_key,updated_at)
       SELECT 'group-a',$1,'示範任務'||num,'示範需求','awaiting_approval',gen_random_uuid()::text,
         $2::timestamptz+num*interval '1 minute' FROM generate_series(1,22) AS num`,
      [project, at(-1500)],
    );
    await scan(0);
    const first = await inboxState();
    expect(first.stuckTasks).toHaveLength(20);
    expect(first.stuckTasksTotal).toBe(22);
    expect(first.stuckTasks[0]).toEqual({
      taskId: expect.any(String), title: "示範任務1", reason: expect.stringContaining("審核"), target: "task", actionLabel: "查看待審需求",
    });
    expect(first.stuckTasks[19].title).toBe("示範任務20");
    await db.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [first.stuckTasks[0].taskId]);
    const next = await inboxState();
    expect(next.stuckTasksTotal).toBe(21);
    expect(next.stuckTasks).toHaveLength(20);
    expect(next.stuckTasks[0].title).toBe("示範任務2");
    expect(next.stuckTasks[19].title).toBe("示範任務21");
  });

  it("排隊滿十分鐘才顯示，分別指出暫停派工、記憶體不足、執行器異常與專案停用", async () => {
    const id = await task("queued", "示範查詢", -10);
    await db.query(`UPDATE settings SET value=value || '{"paused":true}' WHERE id=1`);
    await scan(-1);
    expect(await inbox()).toEqual([]);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("暫停派工") }]);
    await db.query(`UPDATE settings SET value=value || '{"paused":false}' WHERE id=1`);
    await health("host_resources", false);
    await scan(0);
    expect(await inbox()).toMatchObject([{ reason: expect.stringContaining("記憶體"), target: "system" }]);
    await health("host_resources", true);
    await health("runner", false);
    await scan(0);
    expect(await inbox()).toMatchObject([{ reason: expect.stringContaining("執行器"), target: "system" }]);
    await health("runner", true);
    await db.query("UPDATE projects SET enabled=false WHERE id=$1", [project]);
    await scan(0);
    expect(await inbox()).toMatchObject([{ reason: expect.stringContaining("專案已停用") }]);
  });

  it("有實際執行佔用名額才說同時數已滿；訂閱模式才看每日次數", async () => {
    await db.query(`UPDATE settings SET value=value || '{"max_runs":1,"ai_mode":"subscription","daily_runs":1}' WHERE id=1`);
    const id = await task("queued", "示範查詢", -11);
    const active = await task("running");
    const runId = await run(active, 0, null);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("同時執行") }]);
    await db.query("UPDATE runs SET completed_at=$2,outcome='answered' WHERE id=$1", [runId, at(0)]);
    await db.query("UPDATE tasks SET status='answered' WHERE id=$1", [active]);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("今日執行次數") }]);
    await db.query(`UPDATE settings SET value=value || '{"ai_mode":"api"}' WHERE id=1`);
    await scan(0);
    expect(await inbox()).toMatchObject([{ reason: expect.not.stringMatching(/今日執行次數|同時執行.*滿/) }]);
  });

  it("心跳停止或超過期限與緩衝才提示，不更動執行與回收鎖", async () => {
    const id = await task("running");
    const runId = await run(id, 0, null);
    await scan(0.5);
    expect(await inbox()).toEqual([]);
    await scan(1);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("心跳") }]);
    await db.query("UPDATE tasks SET status='reviewing' WHERE id=$1", [id]);
    await db.query("UPDATE runs SET heartbeat_at=$2 WHERE id=$1", [runId, at(32)]);
    await scan(32);
    expect(await inbox()).toMatchObject([{ reason: expect.stringContaining("期限") }]);
    expect(await db.one("SELECT completed_at FROM runs WHERE id=$1", [runId])).toEqual({ completed_at: null });
  });

  it("等候一天分辨審核、補問、選專案及合併，已結束的任務立即離開收件匣", async () => {
    const approval = await task("awaiting_approval", "示範審核");
    const question = await task("awaiting_approval", "示範補問");
    const selection = await task("awaiting_approval", "示範選擇");
    const ready = await task("ready", "示範合併");
    await db.query(`UPDATE tasks SET question='{"text":"需要哪一個範例？"}' WHERE id=$1`, [question]);
    await db.query("UPDATE tasks SET project_id=NULL WHERE id=$1", [selection]);
    await scan(1439);
    expect(await inbox()).toEqual([]);
    await scan(1440);
    const items = await inbox();
    expect(items).toHaveLength(4);
    for (const [id, reason] of [[approval, "審核"], [question, "補問"], [selection, "專案"], [ready, "合併"]])
      expect(items).toContainEqual(expect.objectContaining({ taskId: id, target: "task", reason: expect.stringContaining(reason) }));
    await db.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [approval]);
    expect(await inbox()).toHaveLength(3);
  });

  it("等待額度保留實際阻擋原因，不把無法確認訂閱誤報為用完", async () => {
    const id = await task("budget_wait", "示範需求", -11);
    await db.query(`UPDATE settings SET value=value || '{"ai_mode":"subscription"}' WHERE id=1`);
    await db.query("UPDATE tasks SET last_error='無法確認 Codex 訂閱額度' WHERE id=$1", [id]);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("無法確認") }]);
  });

  it("同專案最近三次執行同類失敗才彙整，中間成功、不同類別或不明輸出都不算", async () => {
    const failed = await task("failed");
    const detail = "upstream_http（HTTP 502）";
    await run(failed, -9, "failed", detail);
    await run(failed, -7, "failed", detail);
    await scan(0);
    expect(await inbox()).toEqual([]);
    await run(failed, -5, "failed", detail);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: failed, reason: expect.stringMatching(/3.*訂閱上游回應失敗.*502/) }]);
    await run(failed, -4, "answered");
    await run(failed, -3, "failed", detail);
    await scan(0);
    expect(await inbox()).toEqual([]);
    await run(failed, -2, "failed", "connection");
    await run(failed, -1, "failed", detail);
    await scan(0);
    expect(await inbox()).toEqual([]);
    for (const minute of [1, 3, 5]) await run(failed, minute, "failed", "未分類的外部內容");
    await scan(7);
    expect(await inbox()).toEqual([]);
  });

  it("同專案連敗只計算過去二十四小時內結束的執行", async () => {
    const id = await task("failed");
    for (const minute of [-1442, -5, -3]) await run(id, minute, "failed", "connection");
    await scan(0);
    expect(await inbox()).toEqual([]);
    await run(id, -1, "failed", "connection");
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("最近 3 次") }]);
    await scan(1441);
    expect(await inbox()).toEqual([]);
  });

  it("非訂閱失敗只比對該次執行期間的結束稽核，不把舊分類或原始錯誤送到收件匣", async () => {
    const id = await task("failed");
    for (const minute of [-9, -6, -3]) {
      const apiRun = minute === -3;
      const runId = await run(id, minute, "failed", apiRun ? "connection" : "示範工具的錯誤輸出");
      if (apiRun) {
        await db.query(
          `WITH reserved AS (INSERT INTO reservations(task_id,day,amount) VALUES($1,'2026-01-01',1) RETURNING id)
           UPDATE runs SET reservation_id=reserved.id FROM reserved WHERE runs.id=$2`, [id, runId],
        );
      }
      await db.query("INSERT INTO audit(task_id,kind,detail,created_at) VALUES($1,'error',$2,$3)", [
        id, "環境問題（測試階段）：示範依賴未啟動。\n錯誤重點：示範輸出\n建議：檢查環境。", at(minute + 0.5),
      ]);
    }
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: "同專案最近 3 次執行都因「環境問題」失敗。" }]);
    await run(id, 0, "failed", "環境問題：這段工具輸出不是稽核");
    await scan(2);
    expect(await inbox()).toEqual([]);
  });

  it("同一任務持續排隊時換原因不重算十分鐘，更新下一步但不重送通知", async () => {
    const id = await task("queued", "示範查詢", -11);
    const notices = () => db.query("SELECT text FROM notifications WHERE kind='stuck_tasks'");
    await db.query("UPDATE projects SET enabled=false WHERE id=$1", [project]);
    await db.query(`UPDATE settings SET value=value || '{"paused":true}' WHERE id=1`);
    await scan(0);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("暫停"), target: "system" }]);
    await db.query(`UPDATE settings SET value=value || '{"paused":false}' WHERE id=1`);
    await scan(9);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: "專案已停用", target: "task", actionLabel: "查看任務與綁定" }]);
    expect(await notices()).toHaveLength(0);
    await scan(10);
    expect(await notices()).toMatchObject([{ text: expect.stringContaining("專案已停用") }]);
    await db.query(`UPDATE settings SET value=value || '{"paused":true}' WHERE id=1`);
    await scan(11);
    await scan(21);
    expect(await inbox()).toMatchObject([{ taskId: id, reason: expect.stringContaining("暫停"), target: "system", actionLabel: "查看派工狀態" }]);
    expect(await notices()).toHaveLength(1);
  });

  it("狀態需連續卡住十分鐘，短暫異常不送；同批只發一則管理者摘要，持續卡住不重送", async () => {
    await task("awaiting_approval", "示範甲", -1440);
    await task("awaiting_approval", "示範乙", -1440);
    const notices = () => db.query("SELECT text,group_id FROM notifications WHERE kind='stuck_tasks'");
    await scan(0);
    await scan(9);
    expect(await notices()).toEqual([]);
    await db.query("UPDATE tasks SET status='answered'");
    await scan(10);
    expect(await notices()).toEqual([]);
    await db.query("UPDATE tasks SET status='awaiting_approval'");
    await scan(11);
    await scan(20);
    expect(await notices()).toEqual([]);
    await scan(21);
    expect(await notices()).toMatchObject([{ text: expect.stringMatching(/2.*審核/), group_id: null }]);
    await scan(60);
    expect(await notices()).toHaveLength(1);
    expect(await prepareDigest(db, "action")).toMatchObject({ text: expect.stringContaining("收件匣") });
    await db.query("UPDATE tasks SET status='cancelled'");
    await scan(61);
    expect(await prepareDigest(db, "action")).toBeNull();
  });
});
