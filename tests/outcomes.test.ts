import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { db, reset, fixture } from "./helpers.js";
import { Retrieval, requestBackfill } from "../server/retrieval.js";
import type { Task } from "../shared/types.js";
beforeEach(reset);
afterAll(() => db.close());
const fake = {
  embed: vi.fn(async (words: string[]) =>
    words.map((w) => {
      const v = Array<number>(1024).fill(0);
      v[w.includes("截圖") ? 0 : 1] = 1;
      return v;
    }),
  ),
};
async function task(p: string, k: string, status: string, group = "group-a") {
  return db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key,last_error) VALUES($1,$2,$3,$3,$4,$3,'缺少畫面證據') RETURNING *",
    [p, group, k, status],
  );
}
it("回填舊失敗與新完成結果；開發最多取三筆同專案結果，排除自己與已解除綁定的群組", async () => {
  const p = await fixture(),
    r = new Retrieval(db, fake);
  const old = await task(p, "截圖驗收", "failed");
  await db.query(
    "UPDATE tasks SET last_error='截圖驗收失敗：375px 證據不足' WHERE id=$1",
    [old.id],
  );
  const q = (
    await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo) VALUES('隱私','other/private') RETURNING id",
    )
  ).id;
  await db.query("INSERT INTO groups(id,name) VALUES('b','乙群')");
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('b',$1),('b',$2)",
    [p, q],
  );
  await task(q, "乙群機密截圖", "failed", "b");
  const shared = await task(p, "共用專案截圖", "merged", "b");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  for (const title of ["批次匯出", "資料統計", "檔案清單"])
    await task(p, title, "ready");
  const current = await task(p, "新截圖", "ready");
  await requestBackfill(db);
  while (await r.indexBatch()) {}
  let results = await r.pastOutcomes(current, true);
  expect(results).toHaveLength(3);
  expect(results.map((x) => x.taskId)).toContain(old.id);
  expect(results.map((x) => x.taskId)).toContain(shared.id);
  expect(results.map((x) => x.taskId)).not.toContain(current.id);
  expect(JSON.stringify(results)).not.toContain("乙群機密");
  expect(results.find((x) => x.taskId === old.id)?.summary).toContain("375px");
  expect(
    results.every(
      (x) => Number.isFinite(x.score) && x.source_time instanceof Date,
    ),
  ).toBe(true);
  expect(
    (await r.lookup("group-a", "截圖", [], [p], true)).hits.every((h) =>
      ["task", "message", "memory", "knowledge"].includes(h.kind),
    ),
  ).toBe(true);
  await db.query(
    "DELETE FROM group_projects WHERE group_id='b' AND project_id=$1",
    [p],
  );
  results = await r.pastOutcomes(current, true);
  expect(results.map((x) => x.taskId)).not.toContain(shared.id);
  await db.query(
    "UPDATE tasks SET status='merged',last_error=NULL,review_note='審查已驗證截圖' WHERE id=$1",
    [old.id],
  );
  expect(
    await db.query(
      "SELECT 1 FROM embeddings WHERE kind='outcome' AND ref_id=$1",
      [old.id],
    ),
  ).toHaveLength(0);
  while (await r.indexBatch()) {}
  expect(
    await db.one(
      "SELECT count(*)::int n FROM embeddings WHERE kind='outcome' AND ref_id=$1 AND content LIKE '%狀態：已合併%' AND content LIKE '%審查已驗證截圖%' AND content NOT LIKE '%失敗原因%' ",
      [old.id],
    ),
  ).toEqual({ n: 1 });
  await db.query("UPDATE tasks SET status='queued' WHERE id=$1", [old.id]);
  expect(
    (await r.pastOutcomes(current, true)).map((x) => x.taskId),
  ).not.toContain(old.id);
});
it("經驗檢索停用時零呼叫，模型離線時記錄原因並交回空的參考清單", async () => {
  const p = await fixture();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  await task(p, "截圖", "failed");
  const current = await task(p, "新需求", "queued");
  await new Retrieval(db, fake).indexBatch();
  const embed = vi.fn(async () => {
    throw Error("離線");
  });
  const r = new Retrieval(db, { embed });
  expect(await r.pastOutcomes(current, false)).toEqual([]);
  expect(embed).not.toHaveBeenCalled();
  expect(await r.pastOutcomes(current, true)).toEqual([]);
  expect(
    await db.one("SELECT ok FROM service_health WHERE name='outcomes'"),
  ).toEqual({ ok: false });
});

it("同專案其他分支的舊結果不混入本次分支經驗", async () => {
  const p = await fixture(),
    r = new Retrieval(db, fake);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  const main = await task(p, "主線截圖", "merged");
  const develop = await task(p, "開發線截圖", "merged");
  await db.query("UPDATE tasks SET target_branch='develop' WHERE id=$1", [
    develop.id,
  ]);
  const current = await task(p, "新截圖需求", "queued");
  await requestBackfill(db);
  while (await r.indexBatch()) {}
  expect((await r.pastOutcomes(current, true)).map((t) => t.taskId)).toEqual([
    main.id,
  ]);
  expect(
    (await r.pastOutcomes({ ...current, target_branch: "develop" }, true)).map(
      (t) => t.taskId,
    ),
  ).toEqual([develop.id]);
});
