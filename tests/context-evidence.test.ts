import { beforeEach, afterAll, it, expect } from "vitest";
import { db, reset, fixture, session } from "./helpers.js";
import {
  recordContextEvidence,
  readTaskContextEvidence,
} from "../server/task-context.js";
import { buildApp } from "../server/app.js";
import { createHash } from "node:crypto";
beforeEach(reset);
afterAll(() => db.close());

it("E04：舊版本的晚到證據不能寫入新版，歷史文字變更後顯示失效", async () => {
  const project = await fixture();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES('selected','group-a','text','固定歷史規格')",
  );
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key) VALUES('group-a',$1,'測試','測試','version-evidence') RETURNING id",
    [project],
  );
  const evidence = {
    mechanism: "vector" as const,
    source_kind: "message" as const,
    source_id: "selected",
    source_hash: createHash("sha256").update("固定歷史規格").digest("hex"),
  };
  await recordContextEvidence(
    db.pool,
    task.id,
    "triage-selected",
    [evidence],
    1,
  );
  expect((await readTaskContextEvidence(db, task.id))[0].valid).toBe(true);
  await db.query("UPDATE messages SET text='變更後規格' WHERE id='selected'");
  expect((await readTaskContextEvidence(db, task.id))[0].valid).toBe(false);
  await db.query("UPDATE tasks SET version=2 WHERE id=$1", [task.id]);
  await recordContextEvidence(db.pool, task.id, "execution", [evidence], 1);
  expect(
    await db.query(
      "SELECT id FROM task_context_evidence WHERE task_id=$1 AND phase='execution'",
      [task.id],
    ),
  ).toEqual([]);
});

it("C01/C02：明確區分近期對話與向量來源，保留分數及來源 ID 而不複製內容", async () => {
  const project = await fixture();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES('recent','group-a','text','私人近期原文'),('old','group-a','text','歷史規格原文')",
  );
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key) VALUES('group-a',$1,'測試','測試','context-evidence') RETURNING id",
    [project],
  );
  await recordContextEvidence(db.pool, task.id, "triage", [
    { mechanism: "recent", source_kind: "message", source_id: "recent" },
    {
      mechanism: "vector",
      source_kind: "message",
      source_id: "old",
      score: 0.8123,
    },
  ]);
  const rows = await readTaskContextEvidence(db, task.id);
  expect(rows.map((r) => [r.mechanism, r.source_id, r.valid])).toEqual(
    expect.arrayContaining([
      ["vector", "old", true],
      ["recent", "recent", true],
    ]),
  );
  expect(rows.find((r) => r.source_id === "old")?.score).toBe(0.8123);
  expect(JSON.stringify(rows)).not.toMatch(/私人近期原文|歷史規格原文/);
  await db.query("UPDATE messages SET revoked=true,text=NULL WHERE id='old'");
  expect(
    (await readTaskContextEvidence(db, task.id)).find(
      (r) => r.source_id === "old",
    )?.valid,
  ).toBe(false);
  await db.query("DELETE FROM group_projects WHERE group_id='group-a'");
  // 群組訊息本身屬於同群，不因專案解綁暴露到其他群組。
  await db.query("INSERT INTO groups(id,name) VALUES('group-b','另一群')");
  await db.query("UPDATE tasks SET group_id='group-b' WHERE id=$1", [task.id]);
  expect(
    (await readTaskContextEvidence(db, task.id)).every((r) => !r.valid),
  ).toBe(true);
});

it("E12：任務證據需要管理者登入，回應禁用快取且不含執行器授權", async () => {
  const project = await fixture();
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key) VALUES('group-a',$1,'證據','摘要','auth-evidence') RETURNING id",
    [project],
  );
  const app = await buildApp(db);
  try {
    expect(
      (await app.inject({ url: `/api/tasks/${task.id}` })).statusCode,
    ).toBe(401);
    const headers = await session();
    const response = await app.inject({
      url: `/api/tasks/${task.id}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ images: [], contextEvidence: [] });
    expect(response.body).not.toMatch(/runnerSecret|token_hash|auth\.json/);
  } finally {
    await app.close();
  }
});
