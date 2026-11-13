import { afterAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { cleanup } from "../server/maintenance.js";
beforeEach(reset);
afterAll(() => db.close());

async function setup() {
  const project = await fixture();
  const headers = await session();
  const app = await buildApp(db);
  const data = await sharp({
    create: { width: 3, height: 3, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES('source','group-a','text','請查詢流程')",
  );
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,mode,answer,source_ids,dedupe_key) VALUES($1,'group-a','測試報告','摘要','answered','query','完整報告',ARRAY['source'],'report-api') RETURNING id",
    [project],
  );
  const run = await db.one<{ id: string }>(
    "INSERT INTO runs(task_id,version,model,deadline,completed_at) VALUES($1,1,'fake',now(),now()) RETURNING id",
    [task.id],
  );
  const id = randomUUID();
  await db.query(
    "INSERT INTO query_report_images(id,task_id,run_id,version,key,position,caption,kind,source,mime,data) VALUES($1,$2,$3,1,'img-1',0,'實際畫面','repository','docs/view.png','image/png',$4)",
    [id, task.id, run.id, data],
  );
  return {
    app,
    headers,
    data,
    task,
    id,
    url: `/api/tasks/${task.id}/report-images/${id}`,
  };
}
it("附件與任務使用相同登入邊界，僅回傳中繼資料並禁止快取", async () => {
  const s = await setup();
  try {
    expect((await s.app.inject(s.url)).statusCode).toBe(401);
    const response = await s.app.inject({ url: s.url, headers: s.headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(s.data)).toBe(true);
    expect(response.headers["cache-control"]).toBe("no-store");
    const detail = (
      await s.app.inject({ url: `/api/tasks/${s.task.id}`, headers: s.headers })
    ).json();
    expect(detail.reportImages).toEqual([
      expect.objectContaining({ key: "img-1", caption: "實際畫面" }),
    ]);
    expect(detail.reportImages[0].data).toBeUndefined();
    expect(
      (
        await s.app.inject({
          url: s.url.replace(s.task.id, randomUUID()),
          headers: s.headers,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await s.app.close();
  }
});
it.each(["撤回", "到期", "版本更新", "取消", "圖片參考失效"])(
  "%s 後停止提供附件並清理內容",
  async (reason) => {
    const s = await setup();
    try {
      if (reason === "撤回") await db.query("UPDATE messages SET revoked=true");
      if (reason === "到期")
        await db.query(
          "UPDATE messages SET received_at=now()-interval '31 days'",
        );
      if (reason === "版本更新") await db.query("UPDATE tasks SET version=2");
      if (reason === "取消")
        await db.query("UPDATE tasks SET status='cancelled'");
      if (reason === "圖片參考失效")
        await db.query(
          "INSERT INTO task_image_refs(task_id,task_version,message_id,source_hash,mime,origin) VALUES($1,1,'missing',$2,'image/png','direct')",
          [s.task.id, "0".repeat(64)],
        );
      const response = await s.app.inject({ url: s.url, headers: s.headers });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await s.app.inject({
            url: `/api/tasks/${s.task.id}`,
            headers: s.headers,
          })
        ).json().reportImages,
      ).toEqual([]);
      await cleanup(db);
      expect(await db.query("SELECT id FROM query_report_images")).toHaveLength(
        0,
      );
    } finally {
      await s.app.close();
    }
  },
);
