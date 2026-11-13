import { afterAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { frictionMetrics } from "../server/friction.js";

let project: string;
beforeEach(async () => {
  await reset();
  project = await fixture();
});
afterAll(() => db.close());

async function task(fields: Record<string, unknown>) {
  const f = {
    mode: "query",
    status: "answered",
    parent_id: null,
    routing: {
      status: "clear",
      basis: "explicit",
      reason: "指名",
      evidence: [],
    },
    created: "now()-interval '1 hour'",
    ...fields,
  };
  return db.one<{ id: string }>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,parent_id,project_routing,dedupe_key,created_at,updated_at)
     VALUES($1,'group-a','題目','題目','["回答"]',$2,$3,$4,$5,$6,${f.created},${f.created}) RETURNING id`,
    [
      project,
      f.status,
      f.mode,
      f.parent_id,
      JSON.stringify(f.routing),
      randomUUID(),
    ],
  );
}
const audit = (
  taskId: string,
  kind: string,
  detail = "管理者操作",
  at = "now()",
) =>
  db.query(
    `INSERT INTO audit(task_id,kind,detail,created_at) VALUES($1,$2,$3,${at})`,
    [taskId, kind, detail],
  );

it("從稽核紀錄與通知算出回應次數、等待時間、接錯題與返工率", async () => {
  // 查詢 A：人回應 2 次（看板核准 + LINE 回答補問），10 分鐘後回答，群組第一則訊息 2 分鐘後。
  const a = await task({});
  const msg = randomUUID();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,received_at,processed) VALUES($1,'group-a','text','問題',now()-interval '1 hour',true)",
    [msg],
  );
  await db.query("UPDATE tasks SET source_ids=ARRAY[$2] WHERE id=$1", [
    a.id,
    msg,
  ]);
  await audit(a.id, "approve");
  await audit(a.id, "question_answered", "群組成員（LINE） 回答…");
  await audit(a.id, "answered", "查詢已回覆", "now()-interval '50 minutes'");
  await db.query(
    "INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,sent_at) VALUES($1,'group_question','k1','問','group-a',now()-interval '58 minutes')",
    [a.id],
  );
  // 查詢 B：被改接一次。
  const b = await task({});
  await audit(b.id, "relinked");
  // 修改 C：已合併，之後 1 天內有追加修改 → 返工。
  const c = await task({ mode: "change", status: "merged" });
  await audit(c.id, "merged", "合併", "now()-interval '30 minutes'");
  await task({
    mode: "change",
    status: "awaiting_approval",
    parent_id: c.id,
    created: "now()-interval '10 minutes'",
  });
  // 舊任務不在 7 天範圍內。
  await task({ created: "now()-interval '20 days'" });

  const m = await frictionMetrics(db, 7, null);
  expect(m.tasks).toBe(4);
  // 回應：A 2 次 + B 1 次（relinked）= 3，平均 0.75；看板：A 核准 + B 改接 = 2，平均 0.5。
  expect(m.responsesPerTask).toBe(0.75);
  expect(m.dashboardPerTask).toBe(0.5);
  expect(m.relinked).toBe(1);
  expect(m.firstReplySeconds).toBe(120);
  expect(m.answerSeconds).toBe(600);
  expect(m.reworkBase).toBe(1);
  expect(m.reworkRate).toBe(1);
  expect((await frictionMetrics(db, 7, "group-b")).tasks).toBe(0);
});

it("重講背景：沒有接上前一題、30 分鐘內又指名同專案", async () => {
  await task({ created: "now()-interval '20 minutes'" });
  await task({ created: "now()-interval '5 minutes'" });
  // 接上前一題的不算。
  const parent = await task({ created: "now()-interval '15 minutes'" });
  await task({ parent_id: parent.id, created: "now()-interval '3 minutes'" });
  const m = await frictionMetrics(db, 7, null);
  expect(m.restated).toBe(2);
});

it("看板 API 需要登入並回傳指標", async () => {
  const app = await buildApp(db);
  try {
    expect(
      (await app.inject({ url: "/api/metrics/friction?days=7" })).statusCode,
    ).toBe(401);
    const r = await app.inject({
      url: "/api/metrics/friction?days=30&group_id=group-a",
      headers: await session(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ days: 30, groupId: "group-a", tasks: 0 });
  } finally {
    await app.close();
  }
});
