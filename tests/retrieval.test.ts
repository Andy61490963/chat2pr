import { afterAll, beforeEach, it, expect, vi } from "vitest";
import { db, reset, fixture, session } from "./helpers.js";
import {
  Retrieval,
  requestBackfill,
  referencedSources,
} from "../server/retrieval.js";
import { cleanup } from "../server/maintenance.js";
import { Line } from "../server/line.js";
import { Triage, type Classifier } from "../server/triage.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { buildApp } from "../server/app.js";
beforeEach(reset);
afterAll(() => db.close());
const model = () => ({
  embed: vi.fn(async (texts: string[]) =>
    texts.map((t) => {
      const v = Array<number>(1024).fill(0);
      v[t.includes("報表") ? 0 : 1] = 1;
      return v;
    }),
  ),
});
const turnOn = () =>
  db.query("UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')");
const line = new Line(db);
const msg = (id: string, text: string, group = "group-a", quote?: string) =>
  line.ingest({
    events: [
      {
        webhookEventId: "send-" + id,
        type: "message",
        source: { type: "group", groupId: group },
        message: { type: "text", id, text, quotedMessageId: quote },
      },
    ],
  });
const unsend = (id: string) =>
  line.ingest({
    events: [
      {
        webhookEventId: "undo-" + id,
        type: "unsend",
        source: { type: "group", groupId: "group-a" },
        unsend: { messageId: id },
      },
    ],
  });
const github = new GitHub();
github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
  sha: "測試",
  paths: [],
  files: {},
  truncated: false,
});
async function task(p: string) {
  return (
    await db.one<{ id: string }>(
      "INSERT INTO tasks(group_id,project_id,title,summary,acceptance,status,dedupe_key,updated_at) VALUES('group-a',$1,'營收報表','每月彙總','[\"顯示總額\"]','merged','報表',now()-interval '100 days') RETURNING id",
      [p],
    )
  ).id;
}
it("管理者補建對話、任務、記憶與結果索引可重跑；版本變更、記憶刪除、解除綁定會更新或移除索引", async () => {
  const p = await fixture(),
    id = await task(p);
  await msg("m", "報表");
  await db.query(
    "INSERT INTO group_memories(group_id,project_id,content,source) VALUES('group-a',$1,'群組使用報表','manual')",
    [p],
  );
  await db.query(
    "INSERT INTO project_knowledge(project_id,content,source) VALUES($1,'報表格式','manual')",
    [p],
  );
  const api = await buildApp(db);
  try {
    expect(
      (await api.inject({ method: "POST", url: "/api/rag/backfill" }))
        .statusCode,
    ).toBe(401);
    const headers = await session();
    expect(
      (await api.inject({ method: "POST", url: "/api/rag/backfill", headers }))
        .statusCode,
    ).toBe(202);
    const fake = model(),
      r = new Retrieval(db, fake);
    expect(await r.indexBatch()).toBe(5);
    await requestBackfill(db);
    expect(await r.indexBatch()).toBe(0);
    expect(fake.embed).toHaveBeenCalledTimes(1);
    expect(
      await db.one(
        "SELECT count(*)::int n FROM embeddings WHERE content IS NULL",
      ),
    ).toEqual({ n: 4 });
    const state = (
      await api.inject({ method: "GET", url: "/api/state", headers })
    ).json();
    expect(state.rag).toMatchObject({
      active: false,
      counts: { message: 1, task: 1, memory: 1, knowledge: 1, outcome: 1 },
    });
    expect(state.rag.completed_at).toBeTruthy();
    await turnOn();
    await db.query(
      "UPDATE tasks SET summary='改為排行',version=version+1 WHERE id=$1",
      [id],
    );
    await r.indexBatch();
    expect(fake.embed.mock.lastCall?.[0][0]).toContain("改為排行");
    await db.query("DELETE FROM group_memories");
    expect(
      await db.query("SELECT id FROM embeddings WHERE kind='memory'"),
    ).toHaveLength(0);
    await db.query("DELETE FROM group_projects");
    expect(await db.query("SELECT kind FROM embeddings")).toEqual([
      { kind: "message" },
    ]);
  } finally {
    await api.close();
  }
});
it("撤回不會讓推論中的舊版本復活；保存期縮短時立即停止讀取，清理後刪除向量", async () => {
  const p = await fixture();
  await turnOn();
  await msg("a", "報表草稿");
  const r = new Retrieval(db, {
    embed: async (texts) => {
      await unsend("a");
      return model().embed(texts);
    },
  });
  await r.indexBatch();
  expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
  await msg("b", "上週的報表");
  await db.query(
    "UPDATE messages SET received_at=now()-interval '7 days' WHERE id='b'",
  );
  const live = new Retrieval(db, model());
  await live.indexBatch();
  expect(
    (await live.lookup("group-a", "報表", [], [p], true)).hits.map((h) => h.id),
  ).toEqual(["b"]);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{retention_days}','3')",
  );
  expect((await live.lookup("group-a", "報表", [], [p], true)).hits).toEqual(
    [],
  );
  await cleanup(db);
  expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
  expect(
    (await db.one("SELECT text FROM messages WHERE id='b'")).text,
  ).toBeNull();
});
it("判讀從上週對話關聯到原任務，排除異群、近期與引用訊息；詳情在撤回後不再顯示時間", async () => {
  const p = await fixture();
  await turnOn();
  const id = await task(p);
  await db.query("INSERT INTO groups(id,name) VALUES('b','其他群')");
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('b',$1)",
    [p],
  );
  for (const [key, content, g] of [
    ["old", "上週討論營收報表", "group-a"],
    ["recent", "最近討論", "group-a"],
    ["quoted", "引用的格式要求", "group-a"],
    ["foreign", "他群的營收報表", "b"],
  ])
    await msg(key, content, g);
  await db.query(
    "UPDATE messages SET processed=true,received_at=CASE WHEN id='recent' THEN now() ELSE now()-interval '7 days' END",
  );
  const fake = model(),
    r = new Retrieval(db, fake);
  await r.indexBatch();
  await msg("new", "上週那個報表也要手機版", "group-a", "quoted");
  await db.query(
    "UPDATE groups SET first_pending_at=now()-interval '5 minutes'",
  );
  const classify: Classifier["classify"] = async (input) => {
    const ctx = input.context as { retrieved: { id: string }[] };
    expect(input.tasks).toHaveLength(0);
    expect(ctx.retrieved.map((h) => h.id).sort()).toEqual(["old", id].sort());
    expect(fake.embed.mock.lastCall?.[0][0]).toContain("引用的格式要求");
    return [
      {
        kind: "duplicate",
        title: "營收報表",
        summary: "報表",
        acceptance: [],
        sourceIds: ["new"],
        risks: [],
        missing: [],
        relatedTaskId: id,
        projectId: p,
        suggestions: [],
      },
    ];
  };
  await new Triage(db, { classify }, github, line, new Budget(db), r).process(
    "group-a",
  );
  expect((await referencedSources(db, id, "group-a"))[0]).toMatchObject({
    tasks: [{ id, title: "營收報表" }],
    messages: [expect.any(Date)],
  });
  await unsend("old");
  expect((await referencedSources(db, id, "group-a"))[0].messages).toEqual([]);
});
it("模型故障時索引排程重試、判讀不中斷；停用時不呼叫向量模型", async () => {
  const p = await fixture(),
    fake = model(),
    r = new Retrieval(db, fake);
  expect((await r.lookup("group-a", "報表", [], [p], false)).reason).toBe(
    "未啟用",
  );
  expect(fake.embed).not.toHaveBeenCalled();
  await turnOn();
  await msg("new", "嗨");
  fake.embed.mockRejectedValue(new Error("模擬離線"));
  await expect(r.indexBatch()).rejects.toThrow("模擬離線");
  expect(await r.indexBatch()).toBe(0);
  await new Triage(
    db,
    {
      classify: async (input) => {
        expect(input.context).not.toHaveProperty("retrieved");
        return [
          {
            kind: "ignore",
            title: "",
            summary: "",
            acceptance: [],
            sourceIds: ["new"],
            risks: [],
            missing: [],
            relatedTaskId: null,
            projectId: null,
            suggestions: [],
          },
        ];
      },
    },
    github,
    line,
    new Budget(db),
    r,
  ).process("group-a");
  expect(
    (await db.one("SELECT triage_failures FROM groups")).triage_failures,
  ).toBe(0);
  expect((await db.one("SELECT processed FROM messages")).processed).toBe(true);
  expect(
    await db.one("SELECT ok FROM service_health WHERE name='retrieval'"),
  ).toEqual({ ok: false });
  await db.query("UPDATE rag_pending SET available_at=now()");
  await new Retrieval(db, model()).indexBatch();
  expect(await db.one("SELECT kind FROM embeddings")).toEqual({
    kind: "message",
  });
});
it("候選依相似度排序，排除未綁定知識，遵守各類筆數及序列化長度上限", async () => {
  const p = await fixture();
  await turnOn();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) SELECT n::text,'group-a','text',CASE WHEN n=1 THEN '報表' ELSE '其他' END FROM generate_series(1,25) n",
  );
  const q = await db.one<{ id: string }>(
    "INSERT INTO projects(name,repo) VALUES('其他','x/y') RETURNING id",
  );
  await db.query("INSERT INTO groups(id,name) VALUES('b','其他')");
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('b',$1)",
    [q.id],
  );
  await db.query(
    "INSERT INTO project_knowledge(project_id,content,source) SELECT $1,'報表','manual' FROM generate_series(1,7)",
    [p],
  );
  await db.query(
    "INSERT INTO project_knowledge(project_id,content,source) VALUES($1,'異群機密','manual')",
    [q.id],
  );
  const r = new Retrieval(db, model());
  while (await r.indexBatch()) {}
  const get = async () =>
    (await r.lookup("group-a", "報表", [], [p, q.id], true)).hits;
  const hits = await get();
  expect(hits.filter((h) => h.kind === "message")).toHaveLength(20);
  expect(hits.filter((h) => h.kind === "knowledge")).toHaveLength(5);
  expect(hits.find((h) => h.kind === "message")?.id).toBe("1");
  expect(hits.some((h) => h.content === "異群機密")).toBe(false);
  await db.query("UPDATE messages SET text=repeat('很長的報表',5000)");
  while (await r.indexBatch()) {}
  expect(JSON.stringify(await get()).length).toBeLessThanOrEqual(20000);
});
