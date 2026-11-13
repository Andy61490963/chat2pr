import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Tasks } from "../server/tasks.js";
import { cleanup, backupTables } from "../server/maintenance.js";
import {
  saveEvents,
  ObservationBuffer,
  safeDetail,
  connectionFailure,
} from "../server/observation.js";
import { HttpRunner } from "../server/execution.js";
// @ts-expect-error 工作容器採用原生 ESM，無需 TypeScript 編譯。
import { observeTurn } from "../worker/observe.mjs";
beforeEach(reset);
afterAll(() => db.close());
async function fixtureRun() {
  const project = await fixture();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES('source','group-a','text','來源')",
  );
  const t = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,source_ids,dedupe_key) VALUES($1,'group-a','診斷','摘要',ARRAY['source'],'observe') RETURNING id",
    [project],
  );
  const r = await db.one<{ id: string }>(
    "INSERT INTO runs(task_id,version,model,deadline,token_hash,result,observed) VALUES($1,1,'測試模型',now()+interval '30 minutes','不可讀權杖','{\"files\":[\"不可讀原始檔\"]}',true) RETURNING id",
    [t.id],
  );
  return { taskId: t.id, runId: r.id };
}
const event = (seq = 1) => ({
  seq,
  at: new Date().toISOString(),
  phase: "code",
  kind: "thread",
  threadId: randomUUID(),
  detail: "授權 access_token=fictional-sensitive-value",
});

it("管理者唯讀查詢，執行必須屬於指定任務，原始結果與權杖不外洩", async () => {
  const { taskId, runId } = await fixtureRun(),
    app = await buildApp(db),
    headers = await session();
  await saveEvents(db, runId, "runner", [event()]);
  const url = `/api/tasks/${taskId}/runs/${runId}/events`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  const r = await app.inject({ url, headers });
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain("fictional-sensitive-value");
  expect(r.json().events[0].threadId).toBeTruthy();
  const detail = await app.inject({ url: `/api/tasks/${taskId}`, headers });
  expect(detail.body).not.toContain("不可讀");
  expect(detail.json().runs[0].observed).toBe(true);
  expect(
    (
      await app.inject({
        url: `/api/tasks/${randomUUID()}/runs/${runId}/events`,
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect((await app.inject({ url, headers, method: "POST" })).statusCode).toBe(
    404,
  );
  await db.query("UPDATE sessions SET user_id='999999'");
  expect((await app.inject({ url, headers })).statusCode).toBe(401);
  await app.close();
});
it("分頁無遺漏且重複串流事件不重複保存", async () => {
  const { taskId, runId } = await fixtureRun();
  const rows = Array.from({ length: 205 }, (_, i) => event(i + 1));
  await saveEvents(db, runId, "runner", rows);
  await saveEvents(db, runId, "runner", rows);
  const tasks = new Tasks(db),
    a = await tasks.runEvents(taskId, runId),
    b = await tasks.runEvents(taskId, runId, a.nextBefore!);
  expect(a.events).toHaveLength(200);
  expect(a.hasOlder).toBe(true);
  expect(b.events).toHaveLength(5);
  expect(b.hasOlder).toBe(false);
});
it("到期立即不可讀，撤回清除內容且延遲事件不能寫回；備份排除執行輸出", async () => {
  const { taskId, runId } = await fixtureRun(),
    tasks = new Tasks(db);
  await saveEvents(db, runId, "runner", [event()]);
  await db.query("UPDATE runs SET started_at=now()-interval '31 days'");
  expect((await tasks.runEvents(taskId, runId)).events[0]).toMatchObject({
    detail: null,
  });
  await cleanup(db);
  expect((await db.one("SELECT detail FROM run_events")).detail).toBeNull();
  await db.query("UPDATE runs SET started_at=now()");
  await saveEvents(db, runId, "runner", [event(2)]);
  await db.query(
    "UPDATE messages SET revoked=true,text=NULL WHERE id='source'",
  );
  await saveEvents(db, runId, "runner", [event(3)]);
  expect(
    (await db.query("SELECT detail FROM run_events")).every(
      (e) => e.detail === null,
    ),
  ).toBe(true);
  expect(backupTables).not.toContain("run_events");
});
it("執行器事件有界、拒絕未知欄位與錯誤識別碼並遮蔽憑證", () => {
  const b = new ObservationBuffer(),
    id = randomUUID();
  b.add(id, "code", { kind: "thread", threadId: "假識別碼" });
  expect(b.read(id)).toHaveLength(0);
  for (let i = 0; i < 2100; i++)
    b.add(id, "code", {
      kind: "message",
      detail: '{"refresh_token":"fictional-sensitive-value"}',
    });
  expect(b.read(id)).toHaveLength(2001);
  expect(b.read(id, 2000)[0].kind).toBe("truncated");
  expect(JSON.stringify(b.read(id))).not.toContain("fictional-sensitive-value");
  b.forget(id);
  expect(b.read(id)).toEqual([]);
  b.add(id, "code", { kind: "message", detail: "取消後遲到的原文" });
  expect(b.read(id)).toEqual([]);
  expect(
    safeDetail(
      "Bearer secret-value https://user:pass@example.com/p?token=secret-value",
    ),
  ).not.toContain("secret-value");
});
it("連線診斷保留安全錯誤碼，不能夾帶 URL 或憑證", async () => {
  const failure = new TypeError("fetch failed", {
    cause: { code: "ECONNREFUSED", token: "不外洩" },
  });
  expect(connectionFailure(failure, "執行器").message).toContain(
    "ECONNREFUSED",
  );
  await expect(
    new HttpRunner(() => "虛構金鑰", vi.fn().mockRejectedValue(failure)).call("phase", {}),
  ).rejects.toThrow("ECONNREFUSED");
});
it("SDK 串流保留 thread 與命令結果，忽略推理，未完成或失敗必須拋錯", async () => {
  const threadId = randomUUID(),
    emitted: unknown[] = [];
  const events = [
    { type: "thread.started", thread_id: threadId },
    {
      type: "item.completed",
      item: { type: "reasoning", text: "不應保存的推理" },
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "npm test",
        aggregated_output: "一項失敗",
        exit_code: 1,
      },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "處理完成" },
    },
    { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } },
  ];
  const thread = {
    async runStreamed() {
      return {
        events: (async function* () {
          yield* events;
        })(),
      };
    },
  };
  const r = await observeTurn(thread, "不應保存的提示詞", {}, (e: unknown) =>
    emitted.push(e),
  );
  expect(r.final).toBe("處理完成");
  expect(emitted).toContainEqual({ kind: "thread", threadId });
  expect(JSON.stringify(emitted)).not.toContain("不應保存");
  expect(emitted).toContainEqual(
    expect.objectContaining({ kind: "command_end", exitCode: 1 }),
  );
  events.pop();
  await expect(observeTurn(thread, "", {}, () => {})).rejects.toThrow("未完成");
  events.push({ type: "turn.failed", error: { message: "額度不足" } } as never);
  await expect(observeTurn(thread, "", {}, () => {})).rejects.toThrow(
    "額度不足",
  );
});
