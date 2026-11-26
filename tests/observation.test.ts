import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
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
import { SubscriptionBroker } from "../server/subscription-broker.js";
import { phaseEndEvents } from "../server/test-failures.js";
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
it("執行紀錄保存安全的非 UUID 對話識別碼與沒有結束碼的命令", async () => {
  const { taskId, runId } = await fixtureRun();
  const buffer = new ObservationBuffer();
  buffer.add(runId, "code", { kind: "thread", threadId: "sample_thread-27" });
  for (const kind of ["command_start", "command_end"])
    buffer.add(runId, "code", { kind, detail: "範例命令", exitCode: null });
  await saveEvents(db, runId, "runner", buffer.read(runId));
  expect((await new Tasks(db).runEvents(taskId, runId)).events).toMatchObject([
    { kind: "thread", threadId: "sample_thread-27" },
    { kind: "command_start", detail: "範例命令", exitCode: null },
    { kind: "command_end", detail: "範例命令", exitCode: null },
  ]);
});
it("同一次執行跨階段只保存第一筆拒收原因，重送舊輪詢不會減少累計筆數", async () => {
  const { taskId, runId } = await fixtureRun();
  const buffer = new ObservationBuffer();
  buffer.rejectWorkerEvent(runId, "code", "command_end", "欄位不符");
  const first = structuredClone(buffer.read(runId));
  await saveEvents(db, runId, "runner", first);
  for (let i = 0; i < 50; i++)
    buffer.rejectWorkerEvent(runId, "review", "未知", "種類不符");
  buffer.add(runId, "review", { kind: "message", detail: "審查完成" });
  await saveEvents(db, runId, "runner", buffer.read(runId, first[0].seq));
  await saveEvents(db, runId, "runner", first);
  expect((await new Tasks(db).runEvents(taskId, runId)).events).toMatchObject([
    { phase: "code", kind: "worker_event_rejected", rejectedCount: 51,
      detail: "容器事件已丟棄（種類：command_end，原因：欄位不符）" },
    { phase: "review", kind: "message", detail: "審查完成" },
  ]);
  const next = randomUUID();
  buffer.rejectWorkerEvent(next, "code", "未知", "無法解析");
  expect(buffer.read(next)).toMatchObject([{ rejectedCount: 1 }]);
  buffer.forget(runId);
  buffer.rejectWorkerEvent(runId, "review", "未知", "種類不符");
  expect(buffer.read(runId)).toEqual([]);
});
it("一般事件已截斷時仍保留一筆拒收紀錄及累計", () => {
  const runId = randomUUID();
  const buffer = new ObservationBuffer();
  for (let i = 0; i < 2001; i++)
    buffer.add(runId, "code", { kind: "message" });
  buffer.rejectWorkerEvent(runId, "code", "message", "欄位不符");
  buffer.rejectWorkerEvent(runId, "review", "未知", "種類不符");
  expect(buffer.read(runId, 2000)).toMatchObject([
    { kind: "truncated" },
    { kind: "worker_event_rejected", rejectedCount: 2 },
  ]);
});
it.each([
  { phase: "code", outcome: "修改恢復成功", status: 200 },
  { phase: "review", outcome: "審查遭上游拒絕", status: 400 },
])("訂閱重試後$outcome，執行事件只保留重試次數、類別與狀態碼", async ({ phase, status }) => {
  const { taskId, runId } = await fixtureRun();
  const buffer = new ObservationBuffer();
  const upstreamBody = "範例上游內文";
  const upstreamHeader = "SyntheticHeader264";
  const completed = { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } };
  const upstreamFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(upstreamBody, { status: 500, headers: { "x-example": upstreamHeader } }))
    .mockRejectedValueOnce(new Error(upstreamBody))
    .mockResolvedValueOnce(status === 200
      ? new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(upstreamBody, { status }));
  const broker = new SubscriptionBroker({
    credentials: async () => ({
      accessToken: "SyntheticAccess264",
      accountId: "SyntheticAccount264",
      secrets: [],
      models: ["model-test"],
      defaultModel: "model-test",
    }),
    upstreamFetch,
  });
  const app = Fastify();
  broker.register(app);
  try {
    const lease = await broker.issue({
      runId, phase, deadline: Date.now() + 10000,
      onRetry: (event) => buffer.add(runId, phase, event),
    });
    const send = () => app.inject({
      method: "POST",
      url: `${lease.basePath}/responses`,
      headers: { authorization: `Bearer ${lease.token}` },
      payload: { model: lease.model, input: [], stream: true },
    });
    expect((await send()).statusCode).toBe(502);
    expect(buffer.read(runId)).toHaveLength(0);
    expect((await send()).statusCode).toBe(502);
    expect((await send()).statusCode).toBe(status === 200 ? 200 : 502);
    const result = { exitCode: status === 200 ? 0 : 1, stdout: "", stderr: "", upstreamFailure: lease.failure() };
    for (const event of phaseEndEvents(phase, result)) buffer.add(runId, phase, event);
    await saveEvents(db, runId, "runner", buffer.read(runId));
    const { events } = await new Tasks(db).runEvents(taskId, runId);
    expect(events).toMatchObject([
      { phase, kind: "upstream_retry", detail: "上游暫時失敗，已讓 Codex 重試（第 1 次）：upstream_http（HTTP 500）" },
      { phase, kind: "upstream_retry", detail: "上游暫時失敗，已讓 Codex 重試（第 2 次）：connection" },
      { phase, kind: "phase_end", exitCode: result.exitCode, detail: status === 200 ? null : "upstream_http（HTTP 400）" },
    ]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
    expect(JSON.stringify(events)).not.toContain(upstreamHeader);
  } finally {
    broker.close();
    await app.close();
  }
});
it("只有一般階段輸出時，管理 API 保留明細且不回報代理失敗", async () => {
  const { taskId, runId } = await fixtureRun();
  const stderr = "auth（HTTP 401）";
  const [end] = phaseEndEvents("code", { exitCode: 1, stdout: "", stderr });
  await saveEvents(db, runId, "runner", [{ ...end, phase: "code", seq: 1, at: new Date().toISOString() }]);
  const tasks = new Tasks(db);
  expect((await tasks.runEvents(taskId, runId)).events).toMatchObject([{ kind: "phase_end", detail: stderr }]);
  expect((await tasks.detail(taskId)).runs[0]).toMatchObject({ upstream_failure: null });
});

it("到期立即不可讀，撤回清除內容且延遲事件不能寫回；備份排除執行輸出", async () => {
  const { taskId, runId } = await fixtureRun(),
    tasks = new Tasks(db);
  const reason = { kind: "connection" };
  const saveReason = () => db.query("UPDATE runs SET upstream_failure=$2 WHERE id=$1", [runId, reason]);
  await saveEvents(db, runId, "runner", [event()]);
  await saveReason();
  await db.query("UPDATE runs SET started_at=now()-interval '31 days'");
  expect((await tasks.detail(taskId)).runs[0]).toMatchObject({ upstream_failure: null });
  expect((await tasks.runEvents(taskId, runId)).events[0]).toMatchObject({
    detail: null,
  });
  await cleanup(db);
  expect(await db.one("SELECT upstream_failure FROM runs WHERE id=$1", [runId])).toEqual({ upstream_failure: null });
  expect((await db.one("SELECT detail FROM run_events")).detail).toBeNull();
  await db.query("UPDATE runs SET started_at=now()");
  await saveReason();
  await saveEvents(db, runId, "runner", [event(2)]);
  await db.query(
    "UPDATE messages SET revoked=true,text=NULL WHERE id='source'",
  );
  expect(await db.one("SELECT upstream_failure FROM runs WHERE id=$1", [runId])).toEqual({ upstream_failure: null });
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
it("撤回或到期時清掉候選修改裡的修改說明與審查意見，並且不再接續；檔案保留", async () => {
  const { runId } = await fixtureRun();
  const candidate = {
    baseSha: "1111111aaaaaaaaa",
    attempt: 0,
    codexSummary: "依小林的原話「來源」修改",
    feedback: "驗證未通過，請修正：引述了「來源」",
  };
  await db.query("UPDATE runs SET result=$2 WHERE id=$1", [
    runId,
    JSON.stringify({ files: [{ path: "a.ts" }], candidate }),
  ]);
  const result = async () =>
    (await db.one<{ result: Record<string, unknown> }>("SELECT result FROM runs WHERE id=$1", [runId]))!.result;
  await cleanup(db);
  expect((await result()).candidate).toEqual(candidate);
  await db.query("UPDATE messages SET revoked=true,text=NULL WHERE id='source'");
  expect(await result()).toEqual({
    files: [{ path: "a.ts" }],
    candidate: { baseSha: "1111111aaaaaaaaa", attempt: 0, settled: true },
  });
  // 到期：觸發器沒有機會執行時，每日清理一樣會清掉。
  await db.query("UPDATE messages SET revoked=false");
  await db.query("UPDATE runs SET result=$2,started_at=now()-interval '31 days' WHERE id=$1", [
    runId,
    JSON.stringify({ files: [{ path: "a.ts" }], candidate }),
  ]);
  await cleanup(db);
  expect((await result()).candidate).toEqual({ baseSha: "1111111aaaaaaaaa", attempt: 0, settled: true });
});
