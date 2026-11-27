import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { db, fixture, reset, session } from "./helpers.js";

const app = await buildApp(db);
beforeAll(async () => {
  await reset();
  const project = await fixture();
  await db.query(
    "INSERT INTO groups(id,name) VALUES('group-b','示範乙群'),('group-c','演練群')",
  );
  for (const [index, group] of ["group-a", "group-b", "group-c"].entries()) {
    const message = randomUUID();
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,received_at) VALUES($1,$2,'text','提問',current_date-interval '1 hour')",
      [message, group],
    );
    const { id } = await db.one<{ id: string }>(
      `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,dedupe_key,source_ids,created_at) VALUES($1,$2,'問題','問題','[]','answered','query',$3,$4,current_date-interval '1 hour') RETURNING id`,
      [project, group, randomUUID(), index === 1 ? [] : [message]],
    );
    await db.query(
      "INSERT INTO audit(task_id,kind,detail,created_at) VALUES($1,'answered','已回答',current_date-interval '1 hour'+make_interval(secs=>$2))",
      [id, [60, 180, 900][index]],
    );
    await db.query(
      "INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,sent_at) VALUES($1,'group_question',$2,'收到',$3,current_date-interval '1 hour'+make_interval(secs=>$4))",
      [id, randomUUID(), group, [30, 90, 450][index]],
    );
    await db.query(
      "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,dedupe_key) VALUES($1,$2,'變更','變更','[]','cancelled','change',$3)",
      [project, group, randomUUID()],
    );
    if (group === "group-c") {
      await db.query("UPDATE tasks SET updated_at=created_at WHERE id=$1", [
        id,
      ]);
      await db.query(
        "INSERT INTO audit(task_id,kind,detail) VALUES($1,'relinked','改接'),($1,'question_answered','群組成員回答')",
        [id],
      );
      const merged = await db.one<{ id: string }>(
        `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,dedupe_key,project_routing,created_at) VALUES($1,$2,'修改','修改','[]','merged','change',$3,'{"basis":"explicit"}',current_date-interval '50 minutes') RETURNING id`,
        [project, group, randomUUID()],
      );
      await db.query(
        "INSERT INTO audit(task_id,kind,detail,created_at) VALUES($1,'merged','已合併',current_date-interval '45 minutes')",
        [merged.id],
      );
      await db.query(
        "UPDATE tasks SET parent_id=$1 WHERE group_id=$2 AND status='cancelled'",
        [merged.id, group],
      );
    }
  }
});
afterAll(async () => {
  await app.close();
  await db.close();
});

it("切換全部、單群及多群排除會重算整張卡片的每一列", async () => {
  const headers = await session();
  for (const [query, tasks, samples, sources, median, tail, cancelled] of [
    ["", 7, 3, 2, 180, 828, 3],
    ["exclude_group_id=group-c", 4, 2, 1, 120, 174, 2],
    ["exclude_group_id=group-a&exclude_group_id=group-c", 2, 1, 0, 180, 180, 1],
    ["group_id=group-a", 2, 1, 1, 60, 60, 1],
  ] as const) {
    const response = await app.inject({
      url: `/api/metrics/friction?${query}`,
      headers,
    });
    expect(response.json()).toMatchObject({
      tasks,
      responsesPerTask: query ? 0 : 0.29,
      dashboardPerTask: query ? 0 : 0.14,
      restated: query ? 0 : 1,
      relinked: query ? 0 : 1,
      reworkRate: query ? null : 1,
      reworkBase: query ? 0 : 1,
      answerSamples: samples,
      answerSources: sources,
      answerSeconds: median,
      answerP95Seconds: tail,
      firstReplySamples: samples,
      firstReplySources: sources,
      firstReplySeconds: median / 2,
      firstReplyP95Seconds: tail / 2,
      cancelled,
    });
  }
});

it("拒絕不存在的群組、混用範圍與超過上限的排除清單", async () => {
  const headers = await session();
  for (const query of [
    "group_id=missing",
    "exclude_group_id=missing",
    "group_id=group-a&exclude_group_id=group-b",
    Array(21).fill("exclude_group_id=group-a").join("&"),
  ]) {
    expect(
      (await app.inject({ url: `/api/metrics/friction?${query}`, headers }))
        .statusCode,
    ).toBe(400);
  }
});
