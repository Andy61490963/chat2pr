import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { pack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { db, reset, fixture } from "./helpers.js";
import {
  archiveChunks,
  archiveChunksWithStats,
  splitFile,
} from "../server/repo-chunks.js";
import {
  RepoIndexer,
  scheduleRepoIndex,
  relevantFiles,
} from "../server/repo-index.js";
import { Triage, type Classifier } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Retrieval } from "../server/retrieval.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import type { Project } from "../shared/types.js";

beforeEach(reset);
afterAll(() => db.close());
async function tar(files: Record<string, string | Buffer>) {
  const encoder = pack();
  for (const [name, data] of Object.entries(files))
    encoder.entry({ name: "repo-sha/" + name }, data);
  encoder.finalize();
  const buffers: Buffer[] = [];
  for await (const part of encoder)
    if (Buffer.isBuffer(part)) buffers.push(part);
  const bytes = gzipSync(Buffer.concat(buffers));
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(Uint8Array.from(bytes));
      c.close();
    },
  });
}
const on = () =>
  db.query("UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')");
const model = {
  embed: async (words: string[]) =>
    words.map((w) => {
      const v = Array(1024).fill(0);
      v[/wip|看板|欄位/i.test(w) ? 0 : 1] = 1;
      return v;
    }),
};
const loadProject = (id: string) =>
  db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
it("封存檔傳輸錯誤可見且不公開未完成索引", async () => {
  const p = await loadProject(await fixture());
  await on();
  const gh = new GitHub();
  gh.archive = async () =>
    new ReadableStream({
      start(c) {
        c.error(new Error("封存檔傳輸停滯（60 秒未收到資料）"));
      },
    });
  await scheduleRepoIndex(db, p, "timeout-base");
  await new RepoIndexer(db, gh, model).work();
  const state = await db.one<{
    phase: string;
    active_sha: string | null;
    error: string;
  }>("SELECT phase,active_sha,error FROM repo_indexes");
  expect(state.phase).toBe("failed");
  expect(state.active_sha).toBeNull();
  expect(state.error).toContain("封存檔傳輸停滯（60 秒未收到資料）");
  expect(await db.query("SELECT id FROM embeddings WHERE kind='repo'")).toEqual(
    [],
  );
});
it("只取允許的文字檔、保留行號與重疊，專案達上限時仍保留後面檔案", async () => {
  const lines = Array.from({ length: 60 }, (_, i) =>
    String(i).padEnd(60, "字"),
  ).join("\n");
  const parts = [...splitFile("src/長檔.ts", lines)];
  expect(parts[0].line_start).toBe(1);
  expect(parts.at(-1)?.line_end).toBe(60);
  expect(parts[1].line_start).toBeLessThan(parts[0].line_end);
  for (const part of parts)
    expect(part.content).toBe(
      lines
        .split("\n")
        .slice(part.line_start - 1, part.line_end)
        .join("\n"),
    );
  const long = [...splitFile("a.js", "a".repeat(5000) + "\n結束")];
  expect(long.every((p) => p.content.length <= 1500)).toBe(true);
  expect(long.at(-1)?.line_end).toBe(2);
  const result = await archiveChunks(
    await tar({
      "src/a.ts": lines,
      "dist/x.ts": "忽略",
      "bin/x.cs": "忽略",
      "node_modules/x.js": "忽略",
      "public/x.min.js": "忽略",
      "package-lock.json": "{}",
      "big.json": "x".repeat(100 * 1024),
      "large.ts": "x".repeat(200 * 1024 + 1),
      "bad.ts": Buffer.from([255, 0]),
      "private/test.js": "機密檔案",
      "src/config.ts": "-----BEGIN PRIVATE KEY-----",
      "../x.ts": "忽略",
      "src/z.css": "畫面",
    }),
    ["private/"],
    2,
  );
  expect(result.map((x) => x.path)).toEqual(["src/a.ts", "src/z.css"]);
});
it("E02：5001段落明示總數與截斷；依賴目錄不計入，不提高5000上限", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 5001 }, (_, n) => [
      `src/page-${n}.html`,
      `<h1>業務畫面${n}</h1>`,
    ]),
  );
  const result = await archiveChunksWithStats(
    await tar({
      ...files,
      "bower_components/library/index.js": "依賴內容",
      "wwwroot/assets/vendors/table.js": "依賴內容",
      ".venv/package/example.py": "依賴內容",
    }),
    [],
  );
  expect(result.total).toBe(5001);
  expect(result.limit).toBe(5000);
  expect(result.truncated).toBe(true);
  expect(result.chunks).toHaveLength(5000);
  expect(result.chunks.every((p) => p.path.startsWith("src/"))).toBe(true);
}, 30000);
it("E02：超限索引不發布半成品、不反覆推論；分類看見缺索引原因，新SHA可完整重建", async () => {
  const p = await loadProject(await fixture());
  await on();
  const gh = new GitHub();
  const files = Object.fromEntries(
    Array.from({ length: 5001 }, (_, n) => [
      `src/wip-${n}.html`,
      `<h1>業務畫面${n}</h1>`,
    ]),
  );
  gh.archive = vi.fn(async (_p, sha) =>
    tar(sha === "v2" ? files : { "src/wip.html": "看板完整版本" }),
  );
  gh.context = vi.fn(async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
    sha: "v2",
    paths: [],
    files: {},
    truncated: false,
  }));
  const embedding = { embed: vi.fn(model.embed) },
    indexer = new RepoIndexer(db, gh, embedding);
  await scheduleRepoIndex(db, p, "v1");
  await indexer.work();
  const before = embedding.embed.mock.calls.length;
  await scheduleRepoIndex(db, p, "v2");
  await indexer.work();
  expect(
    await db.one(
      "SELECT wanted_sha,active_sha,phase,chunks,total_chunks,truncated FROM repo_indexes",
    ),
  ).toEqual({
    wanted_sha: "v2",
    active_sha: "v1",
    phase: "limited",
    chunks: 1,
    total_chunks: 5001,
    truncated: true,
  });
  expect(embedding.embed).toHaveBeenCalledTimes(before);
  expect(
    await relevantFiles(
      db,
      "group-a",
      [{ id: p.id, sha: "v2" }],
      "看板",
      (await model.embed(["看板"]))[0],
    ),
  ).toEqual({});
  await indexer.work();
  expect(gh.archive).toHaveBeenCalledTimes(2);
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,trigger_mode) VALUES('over-limit','group-a','text','請依未提供的來源規格修改','auto')",
  );
  const classify: Classifier["classify"] = async (input) => {
    expect(input.context).toMatchObject({
      contextLimits: {
        [`repo:${p.id}`]: {
          limit: 5000,
          total: 5001,
          indexed: 0,
          truncated: true,
          available: false,
          sha: "v2",
        },
      },
    });
    expect(JSON.stringify(input.context)).toContain("未發布部分索引");
    return [
      {
        kind: "clarification",
        projectId: p.id,
        title: "等待指定來源",
        summary: "索引超限，未取得規格",
        acceptance: [],
        sourceIds: ["over-limit"],
        risks: [],
        missing: ["請提供指定來源規格"],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  await new Triage(
    db,
    { classify },
    gh,
    new Line(db),
    new Budget(db),
    new Retrieval(db, model),
  ).process("group-a");
  expect((await db.one("SELECT status FROM tasks")).status).toBe(
    "awaiting_approval",
  );
  expect(
    (
      await db.one(
        "SELECT detail FROM audit WHERE kind='retrieval' ORDER BY id DESC LIMIT 1",
      )
    ).detail,
  ).toContain("共 5001 段");
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,trigger_mode) VALUES('clear-request','group-a','text','將頁尾文字改為驗收完成，不需歷史規格','auto')",
  );
  const clear: Classifier["classify"] = async (input) => {
    expect(input.context).toMatchObject({
      contextLimits: {
        [`repo:${p.id}`]: { available: false, truncated: true },
      },
    });
    return [
      {
        kind: "request",
        projectId: p.id,
        title: "明確新文案",
        summary: "頁尾文字改為驗收完成",
        acceptance: ["頁尾顯示驗收完成"],
        sourceIds: ["clear-request"],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  await new Triage(
    db,
    { classify: clear },
    gh,
    new Line(db),
    new Budget(db),
    new Retrieval(db, model),
  ).process("group-a");
  expect(
    (
      await db.one(
        "SELECT status FROM tasks WHERE 'clear-request'=ANY(source_ids)",
      )
    ).status,
  ).toBe("awaiting_approval");
  await scheduleRepoIndex(db, p, "v3");
  await indexer.work();
  expect(
    await db.one(
      "SELECT wanted_sha,active_sha,phase,chunks,total_chunks,truncated FROM repo_indexes",
    ),
  ).toEqual({
    wanted_sha: "v3",
    active_sha: "v3",
    phase: "ready",
    chunks: 1,
    total_chunks: 1,
    truncated: false,
  });
  expect(
    (
      await relevantFiles(
        db,
        "group-a",
        [{ id: p.id, sha: "v3" }],
        "看板",
        (await model.embed(["看板"]))[0],
      )
    )[p.id][0].sha,
  ).toBe("v3");
}, 30000);
it("索引只公開完整的指定版本；相同基底不重建，失敗可重試，移除最後的群組才刪除", async () => {
  const p = await loadProject(await fixture());
  const gh = new GitHub();
  gh.archive = vi.fn(async (_p, sha) =>
    tar({ ["src/" + sha + ".ts"]: "看板" }),
  );
  const indexer = new RepoIndexer(db, gh, model);
  await scheduleRepoIndex(db, p, "v1");
  await indexer.work();
  expect(gh.archive).not.toHaveBeenCalled();
  await on();
  await scheduleRepoIndex(db, p, "v1");
  await indexer.work();
  await scheduleRepoIndex(db, p, "v1");
  await indexer.work();
  expect(gh.archive).toHaveBeenCalledTimes(1);
  const read = async (sha: string, group = "group-a") =>
    relevantFiles(
      db,
      group,
      [{ id: p.id, sha }],
      "看板",
      (await model.embed(["看板"]))[0],
    );
  expect((await read("v1"))[p.id][0].path).toBe("src/v1.ts");
  expect(await read("v1", "foreign")).toEqual({});
  await scheduleRepoIndex(db, p, "v2");
  await new RepoIndexer(db, gh, {
    embed: async () => {
      throw Error("模擬模型故障");
    },
  }).work();
  expect(await db.one("SELECT active_sha,phase FROM repo_indexes")).toEqual({
    active_sha: "v1",
    phase: "failed",
  });
  expect(await read("v2")).toEqual({});
  await db.query("UPDATE repo_indexes SET retry_at=now()");
  await indexer.work();
  expect(
    await db.query("SELECT sha FROM embeddings WHERE kind='repo'"),
  ).toEqual([{ sha: "v2" }]);
  await db.query("INSERT INTO groups(id,name) VALUES('b','共用')");
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('b',$1)",
    [p.id],
  );
  await db.query("DELETE FROM group_projects WHERE group_id='group-a'");
  expect(await read("v2")).toEqual({});
  expect((await read("v2", "b"))[p.id]).toHaveLength(1);
  await db.query("DELETE FROM group_projects WHERE group_id='b'");
  expect(await db.query("SELECT * FROM repo_indexes")).toHaveLength(0);
  expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
});
it("推論中解除綁定或變更目標版本，舊工作無法寫回索引", async () => {
  const p = await loadProject(await fixture());
  await on();
  const gh = new GitHub();
  gh.archive = async () => tar({ "a.ts": "看板" });
  await scheduleRepoIndex(db, p, "v1");
  const changed = new RepoIndexer(db, gh, {
    embed: async (words) => {
      await scheduleRepoIndex(db, p, "v2");
      return model.embed(words);
    },
  });
  await changed.work();
  expect(await db.one("SELECT wanted_sha,phase FROM repo_indexes")).toEqual({
    wanted_sha: "v2",
    phase: "queued",
  });
  expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
  await new RepoIndexer(db, gh, {
    embed: async (words) => {
      await db.query("DELETE FROM group_projects");
      return model.embed(words);
    },
  }).work();
  expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
  expect(await db.query("SELECT project_id FROM repo_indexes")).toHaveLength(0);
});
it("多專案群組的判讀取得相關檔案與行號；異群、過期版本與無關專案不進入提示", async () => {
  const p = await loadProject(await fixture());
  await on();
  const q = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('薪資','test/pay',true,now()) RETURNING *",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
    [q.id],
  );
  const gh = new GitHub();
  gh.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
    sha: "base",
    paths: [],
    files: {},
    truncated: false,
  });
  gh.archive = async (project) =>
    tar(
      project.id === p.id
        ? Object.fromEntries(
            Array.from({ length: 7 }, (_, i) => [
              "src/WIP/view" + i + ".css",
              "WIP 欄位寬度".repeat(120),
            ]),
          )
        : { "pay/salary.py": "payroll salary" },
    );
  const indexer = new RepoIndexer(db, gh, model);
  const classify: Classifier["classify"] = async (input) => {
    const projects = (
      input.context as {
        projects: {
          id: string;
          relevantFiles?: {
            path: string;
            line_start: number;
            content: string;
          }[];
        }[];
      }
    ).projects;
    const files = projects.find((s) => s.id === p.id)?.relevantFiles;
    expect(files?.length).toBeGreaterThanOrEqual(3);
    expect(files?.length).toBeLessThanOrEqual(5);
    expect(
      files?.every(
        (s) =>
          s.path.startsWith("src/WIP/") &&
          s.line_start === 1 &&
          s.content.includes("欄位"),
      ),
    ).toBe(true);
    expect(projects.find((s) => s.id === q.id)?.relevantFiles).toBeUndefined();
    return [
      {
        kind: "ignore",
        projectId: null,
        sourceIds: ["req"],
        title: "",
        summary: "",
        acceptance: [],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  const line = new Line(db);
  await line.ingest({
    events: [
      {
        webhookEventId: "e",
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { type: "text", id: "req", text: "WIP 即時看板欄位太窄" },
      },
    ],
  });
  const cold = vi.fn<Classifier["classify"]>();
  await new Triage(
    db,
    { classify: cold },
    gh,
    line,
    new Budget(db),
    new Retrieval(db, model),
  ).process("group-a");
  expect(cold).not.toHaveBeenCalled();
  expect(await db.one("SELECT processed FROM messages WHERE id='req'")).toEqual(
    { processed: false },
  );
  await indexer.work();
  await indexer.work();
  const ready = vi.fn(classify);
  await new Triage(
    db,
    { classify: ready },
    gh,
    line,
    new Budget(db),
    new Retrieval(db, model),
  ).process("group-a");
  expect(ready).toHaveBeenCalledTimes(1);
  gh.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
    sha: "changed",
    paths: [],
    files: {},
    truncated: false,
  });
  await db.query("UPDATE messages SET processed=false");
  await db.query(
    "UPDATE groups SET first_pending_at=now()-interval '5 minutes' WHERE id='group-a'",
  );
  const skipped: Classifier["classify"] = async (input) => {
    expect(JSON.stringify(input.context)).not.toContain("relevantFiles");
    return [
      {
        kind: "ignore",
        projectId: null,
        sourceIds: ["req"],
        title: "",
        summary: "",
        acceptance: [],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  const fallback = vi.fn(skipped);
  await new Triage(
    db,
    { classify: fallback },
    gh,
    line,
    new Budget(db),
    new Retrieval(db, model),
  ).process("group-a");
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(await db.query("SELECT phase FROM repo_indexes")).toEqual([
    { phase: "queued" },
    { phase: "queued" },
  ]);
});

it("升級時清除舊版本檔案片段；再次遷移保留重新篩選的索引", async () => {
  const p = await loadProject(await fixture());
  await on();
  const gh = new GitHub();
  gh.archive = async () => tar({ "view.ts": "看板" });
  const indexer = new RepoIndexer(db, gh, model);
  const build = async () => {
    await scheduleRepoIndex(db, p, "版本一");
    await indexer.work();
  };
  const counts = () =>
    db.one(
      "SELECT (SELECT count(*)::int FROM repo_indexes) indexes, (SELECT count(*)::int FROM embeddings WHERE kind='repo') chunks",
    );
  await build();
  expect(await counts()).toEqual({ indexes: 1, chunks: 1 });
  await db.query(
    "DELETE FROM rag_migrations WHERE name='repo_source_filter_v2'",
  );
  await db.migrate();
  expect(await counts()).toEqual({ indexes: 0, chunks: 0 });
  await build();
  await db.migrate();
  expect(await counts()).toEqual({ indexes: 1, chunks: 1 });
});

it("多個專案同時命中時各自保留參考資料且序列化後符合字數上限", async () => {
  await fixture();
  await on();
  const vector = (await model.embed(["WIP"]))[0];
  const projects = await db.query<{ id: string }>(
    "INSERT INTO projects(name,repo,enabled,validated_at) SELECT '看板'||n,'test/board-'||n,true,now() FROM generate_series(1,8) n RETURNING id",
  );
  for (const { id } of projects) {
    await db.query(
      "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
      [id],
    );
    await db.query(
      "INSERT INTO repo_indexes(project_id,wanted_sha,active_sha,phase,chunks) VALUES($1,'v','v','ready',5)",
      [id],
    );
    await db.query(
      `INSERT INTO embeddings(kind,ref_id,project_id,sha,chunk,path,line_start,line_end,content,embedding) SELECT 'repo',$1::text||'/'||n,$1::uuid,'v',0,'WIP/'||n||'.ts',100,199,$2,$3::vector FROM generate_series(1,5) n`,
      [id, Array(100).fill('欄位"寬度').join("\n"), JSON.stringify(vector)],
    );
  }
  const files = await relevantFiles(
    db,
    "group-a",
    projects.map((p) => ({ ...p, sha: "v" })),
    "WIP 看板",
    vector,
  );
  expect(Object.keys(files)).toHaveLength(8);
  expect(JSON.stringify(files).length).toBeLessThanOrEqual(15000);
  for (const hits of Object.values(files)) {
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const hit of hits)
      expect(hit.line_end).toBe(
        hit.line_start + hit.content.split("\n").length - 1,
      );
  }
});
