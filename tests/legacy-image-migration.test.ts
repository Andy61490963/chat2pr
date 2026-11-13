import { afterAll, beforeEach, expect, it } from "vitest";
import sharp from "sharp";
import { db, reset, fixture } from "./helpers.js";
import { getTaskImages, imageHash, validateTaskImages } from "../server/image-context.js";

beforeEach(reset);
afterAll(() => db.close());

async function legacy() {
  const project = await fixture();
  // 模擬升級前尚未執行圖片版本遷移；其他 schema 保持真實現況。
  await db.query("DELETE FROM rag_migrations WHERE name='task_image_refs_legacy_v1'");
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  return { project, png };
}
async function source(id: string, png: Buffer | null, options: { revoked?: boolean; days?: number; group?: string } = {}) {
  await db.query("INSERT INTO messages(id,group_id,type,image,image_mime,revoked,processed,received_at) VALUES($1,$2,'image',$3,'image/png',$4,true,now()-make_interval(days=>$5))",
    [id, options.group ?? "group-a", png, options.revoked ?? false, options.days ?? 0]);
}
async function task(project: string, id: string, sources = [id]) {
  return db.one<{ id: string }>("INSERT INTO tasks(project_id,group_id,title,summary,acceptance,source_ids,status,approved_version,dedupe_key) VALUES($1,'group-a','舊圖片需求','依圖片調整欄寬','[\"顯示指定欄寬\"]',$2,'queued',1,$3) RETURNING id",
    [project, sources, id]);
}

it("升級一次固定舊任務有效原圖，連跑兩次仍使用同一需求版本與雜湊", async () => {
  const { project, png } = await legacy();
  await source("valid-legacy", png);
  const t = await task(project, "valid-legacy");
  await db.migrate();
  await db.migrate();
  expect(await db.query("SELECT task_version,source_hash,mime,origin FROM task_image_refs WHERE task_id=$1", [t.id])).toEqual([
    { task_version: 1, source_hash: imageHash(png), mime: "image/png", origin: "direct" },
  ]);
  expect(await db.one("SELECT status,version,approved_version FROM tasks WHERE id=$1", [t.id])).toEqual({ status: "queued", version: 1, approved_version: 1 });
  expect(await getTaskImages(db, t.id, 1)).toHaveLength(1);
});

it("遷移後原圖被換掉，再跑 migrate 不會重新認可新雜湊", async () => {
  const { project, png } = await legacy();
  await source("changed-legacy", png);
  const t = await task(project, "changed-legacy");
  await db.migrate();
  const replacement = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  await db.query("UPDATE messages SET image=$2 WHERE id=$1", ["changed-legacy", replacement]);
  await db.migrate();
  expect(await db.one("SELECT source_hash FROM task_image_refs WHERE task_id=$1", [t.id])).toEqual({ source_hash: imageHash(png) });
  await expect(validateTaskImages(db, t.id, 1)).rejects.toThrow("內容已變更");
});

it("撤回、到期、未取得與跨群圖片都不回填；核准失效且清楚列為待確認", async () => {
  const { project, png } = await legacy();
  await db.query("INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','另一個合成群組',true,'auto')");
  await source("revoked-legacy", png, { revoked: true });
  await source("expired-legacy", png, { days: 31 });
  await source("missing-legacy", null);
  await source("cross-group-legacy", png, { group: "group-b" });
  const tasks = [];
  for (const id of ["revoked-legacy", "expired-legacy", "missing-legacy", "cross-group-legacy"]) tasks.push(await task(project, id));
  await db.migrate();
  await db.migrate();
  expect(await db.query("SELECT * FROM task_image_refs")).toHaveLength(0);
  for (const t of tasks) {
    const row = await db.one<{ status: string; version: number; approved_version: number | null; missing: string[] }>("SELECT status,version,approved_version,missing FROM tasks WHERE id=$1", [t.id]);
    expect(row).toMatchObject({ status: "awaiting_approval", version: 2, approved_version: null });
    expect(row.missing).toHaveLength(1);
    expect(row.missing[0]).toContain("請重新確認有效來源");
    expect(await db.query("SELECT * FROM audit WHERE task_id=$1 AND kind='migration'", [t.id])).toHaveLength(1);
  }
});
