import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { pack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { db, fixture, reset, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { archiveChunksWithStats } from "../server/repo-chunks.js";
import { RepoIndexer, scheduleRepoIndex } from "../server/repo-index.js";
import { GitHub } from "../server/github.js";
import type { Project } from "../shared/types.js";
import { indexPathsFromForm, validIndexPath } from "../shared/repo-scope.js";

beforeEach(reset);
afterAll(() => db.close());
async function archive(files: Record<string, string>) {
  const tar = pack();
  for (const [name, content] of Object.entries(files))
    tar.entry({ name: `snapshot/${name}` }, content);
  tar.finalize();
  const parts: Buffer[] = [];
  for await (const part of tar) if (Buffer.isBuffer(part)) parts.push(part);
  return new Blob([gzipSync(Buffer.concat(parts))]).stream();
}
const load = (id: string) =>
  db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
async function update(paths: unknown, omitted = false) {
  const id = await fixture(),
    app = await buildApp(db),
    headers = await session(),
    p = await load(id);
  const payload = {
    ...p,
    enabled: false,
    ...(omitted ? {} : { index_paths: paths }),
  };
  const result = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    headers,
    payload,
  });
  await app.close();
  return { result, id, p };
}

it("範圍只匹配完整檔案或目錄邊界，不混入相似前綴，也不略過敏感規則", async () => {
  const result = await archiveChunksWithStats(
    await archive({
      "src/wip/view.html": "看板",
      "src/wip/nested/widget.ts": "欄位",
      "src/wip-old/view.html": "不屬於所選目錄",
      "README.md": "說明",
      "README.md.old.ts": "不是指定檔案",
      "src/wip/private/x.ts": "應排除",
      "src/wip/key.ts": "-----BEGIN PRIVATE KEY-----",
    }),
    ["src/wip/private"],
    5000,
    ["src/wip", "README.md"],
  );
  expect(result.chunks.map((c) => c.path).sort()).toEqual([
    "README.md",
    "src/wip/nested/widget.ts",
    "src/wip/view.html",
  ]);
  expect(result.total).toBe(3);
  expect(result.unmatchedPaths).toEqual([]);
});

it("空範圍仍索引全專案，範圍外檔案不占所選範圍的上限", async () => {
  const files = { "src/a.ts": "甲", "src/b.ts": "乙", "outside/a.ts": "丙" };
  expect(
    (await archiveChunksWithStats(await archive(files), [], 5000, [])).total,
  ).toBe(3);
  const selected = await archiveChunksWithStats(await archive(files), [], 2, [
    "src",
  ]);
  expect(selected).toMatchObject({ total: 2, limit: 2, truncated: false });
});

it.each([
  "",
  "/",
  "/src",
  "C:/src",
  "../src",
  "src/../data",
  "src/./data",
  "src//data",
  "src\\data",
  "src/**",
  "src/*.ts",
  "src/[ab]",
  "src/{a,b}",
  "src/?",
  "src/\nsecret",
  "src/\0x",
])("管理 API 拒絕無效索引路徑 %s，不作廢原設定", async (value) => {
  const { result, id, p } = await update([value]);
  expect(result.statusCode).toBe(400);
  expect((await load(id)).config_version).toBe(p.config_version);
});

it("表單只把空白行視為全範圍，根斜線與非法項目仍需拒絕", () => {
  expect(indexPathsFromForm(" \n\n")).toEqual([]);
  expect(indexPathsFromForm(" src/views/\nREADME.md\nsrc/views ")).toEqual([
    "README.md",
    "src/views",
  ]);
  for (const input of ["/", "../private", "src//", "src/**", "README.md\n/"])
    expect(indexPathsFromForm(input).every(validIndexPath)).toBe(false);
});

it("儲存範圍會正規化重複項目、作廢驗證及索引；舊 PUT 省略時保留原值", async () => {
  const id = await fixture(),
    app = await buildApp(db),
    headers = await session();
  const p = await load(id);
  await db.query(
    "INSERT INTO repo_indexes(project_id,wanted_sha,active_sha,phase,chunks) VALUES($1,'base','base','ready',1)",
    [id],
  );
  const result = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    headers,
    payload: {
      ...p,
      enabled: false,
      index_paths: ["src/wip/", "README.md", "src/wip"],
    },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    index_paths: ["README.md", "src/wip"],
    config_version: p.config_version + 1,
    validated_at: null,
    enabled: false,
  });
  expect(
    await db.query("SELECT * FROM repo_indexes WHERE project_id=$1", [id]),
  ).toEqual([]);
  const saved = result.json();
  delete saved.index_paths;
  const legacy = await app.inject({
    method: "PUT",
    url: `/api/projects/${id}`,
    headers,
    payload: { ...saved, name: "舊版管理者改名稱" },
  });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json()).toMatchObject({
    index_paths: ["README.md", "src/wip"],
    config_version: p.config_version + 1,
  });
  await db.migrate();
  await db.migrate();
  expect((await load(id)).index_paths).toEqual(["README.md", "src/wip"]);
  await app.close();
});

it("範圍變更不能保留啟用狀態，也不能由未登入者修改", async () => {
  const id = await fixture(),
    app = await buildApp(db),
    headers = await session(),
    p = await load(id);
  const payload = { ...p, index_paths: ["src"] };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/projects/${id}`,
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/projects/${id}`,
        payload: { ...payload, enabled: false },
      })
    ).statusCode,
  ).toBe(401);
  expect((await load(id)).index_paths).toEqual([]);
  await app.close();
});

it.each([
  { paths: ["typo"] },
  { paths: ["src", "typo"] },
  { paths: ["private"] },
])(
  "指定範圍 $paths 無可索引內容時顯示需處理，不能發布其他部分",
  async ({ paths }) => {
    const id = await fixture();
    await db.query(
      "UPDATE projects SET index_paths=$2,sensitive_paths=ARRAY['private'] WHERE id=$1",
      [id, paths],
    );
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
    );
    const p = await load(id),
      github = new GitHub();
    github.archive = async () =>
      archive({ "src/view.html": "看板", "private/hidden.ts": "敏感來源" });
    const model = {
      embed: vi.fn(async (texts: string[]) =>
        texts.map(() => Array(1024).fill(0.01)),
      ),
    };
    await scheduleRepoIndex(db, p, "scope-base");
    await new RepoIndexer(db, github, model).work();
    const result = await db.one(
      "SELECT phase,active_sha,error FROM repo_indexes WHERE project_id=$1",
      [id],
    );
    expect(result.phase).toBe("failed");
    expect(result.active_sha).toBeNull();
    expect(result.error).toContain("索引範圍");
    expect(result.error).toContain("可索引");
    expect(model.embed).not.toHaveBeenCalled();
    expect(
      await db.query("SELECT id FROM embeddings WHERE kind='repo'"),
    ).toEqual([]);
  },
);

it("所選範圍可完整建置向量，範圍外原始碼仍保留於下載來源", async () => {
  const id = await fixture();
  await db.query("UPDATE projects SET index_paths=ARRAY['src'] WHERE id=$1", [
    id,
  ]);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  const github = new GitHub();
  github.archive = vi.fn(async () =>
    archive({ "src/view.html": "看板", "other/view.html": "範圍外來源" }),
  );
  const model = {
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => Array(1024).fill(0.01)),
    ),
  };
  await scheduleRepoIndex(db, await load(id), "scope-base");
  await new RepoIndexer(db, github, model).work();
  expect(
    await db.one(
      "SELECT phase,active_sha,chunks,total_chunks,truncated FROM repo_indexes WHERE project_id=$1",
      [id],
    ),
  ).toEqual({
    phase: "ready",
    active_sha: "scope-base",
    chunks: 1,
    total_chunks: 1,
    truncated: false,
  });
  expect(
    (
      await db.query<{ path: string }>(
        "SELECT path FROM embeddings WHERE kind='repo'",
      )
    ).map((r) => r.path),
  ).toEqual(["src/view.html"]);
  // 來源介面仍回傳完整封存檔；範圍僅套用於索引分段。
  const complete = await archiveChunksWithStats(
    await github.archive(await load(id), "scope-base"),
    [],
  );
  expect(complete.chunks.map((c) => c.path).sort()).toEqual([
    "other/view.html",
    "src/view.html",
  ]);
});

it("資料庫拒絕非法範圍，空範圍仍是新安裝預設值", async () => {
  const id = await fixture();
  expect((await load(id)).index_paths).toEqual([]);
  for (const value of [
    "../src",
    "src\\secret",
    "src/**",
    "/src",
    "src//a",
    "C:/src",
  ])
    await expect(
      db.query("UPDATE projects SET index_paths=$2 WHERE id=$1", [id, [value]]),
    ).rejects.toMatchObject({ code: "23514" });
});

it("舊版建立專案預設全範圍，明確空陣列可恢復全儲存庫", async () => {
  const app = await buildApp(db),
    headers = await session();
  const installation = vi
    .spyOn(GitHub.prototype, "installation")
    .mockResolvedValue(1);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: {
        name: "範圍專案",
        repo: "fixture/scoped",
        base_branch: "main",
        image: "fixture-image",
        install_command: "",
        test_command: "",
        sensitive_paths: [],
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().index_paths).toEqual([]);
    const scoped = await app.inject({
      method: "PUT",
      url: `/api/projects/${created.json().id}`,
      headers,
      payload: { ...created.json<Project>(), index_paths: ["src"] },
    });
    expect(scoped.statusCode).toBe(200);
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/projects/${created.json().id}`,
      headers,
      payload: { ...scoped.json<Project>(), index_paths: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().index_paths).toEqual([]);
    expect(cleared.json().config_version).toBe(
      scoped.json().config_version + 1,
    );
  } finally {
    installation.mockRestore();
    await app.close();
  }
});

it("推論期間變更範圍會阻止舊 generation 發布，同 SHA 重驗後可建立新範圍", async () => {
  const id = await fixture(),
    app = await buildApp(db),
    headers = await session();
  await db.query("UPDATE projects SET index_paths=ARRAY['src'] WHERE id=$1", [
    id,
  ]);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  const p = await load(id),
    github = new GitHub();
  github.archive = async () =>
    archive({ "src/view.html": "看板", "other/view.html": "其他看板" });
  let changed = false;
  const model = {
    embed: async (texts: string[]) => {
      if (!changed) {
        changed = true;
        const response = await app.inject({
          method: "PUT",
          url: `/api/projects/${id}`,
          headers,
          payload: { ...p, enabled: false, index_paths: ["other"] },
        });
        expect(response.statusCode).toBe(200);
      }
      return texts.map(() => Array(1024).fill(0.01));
    },
  };
  await scheduleRepoIndex(db, p, "same-base");
  await new RepoIndexer(db, github, model).work();
  expect(await db.query("SELECT * FROM repo_indexes")).toEqual([]);
  expect(await db.query("SELECT * FROM embeddings WHERE kind='repo'")).toEqual(
    [],
  );
  // 隔離 fixture 模擬重新驗證通過；沒有跳過正式環境的驗證。
  await db.query("UPDATE projects SET validated_at=now() WHERE id=$1", [id]);
  await scheduleRepoIndex(db, await load(id), "same-base");
  await new RepoIndexer(db, github, model).work();
  expect(
    (
      await db.query<{ path: string }>(
        "SELECT path FROM embeddings WHERE kind='repo'",
      )
    ).map((r) => r.path),
  ).toEqual(["other/view.html"]);
  expect((await db.one("SELECT phase FROM repo_indexes")).phase).toBe("ready");
  await app.close();
});

it("全儲存庫沒有可索引文字不能報空索引成功", async () => {
  const id = await fixture();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  const github = new GitHub();
  github.archive = async () => archive({ "README.md": "  \n" });
  const model = { embed: vi.fn(async () => []) };
  await scheduleRepoIndex(db, await load(id), "empty-base");
  await new RepoIndexer(db, github, model).work();
  expect(await db.one("SELECT phase,active_sha FROM repo_indexes")).toEqual({
    phase: "failed",
    active_sha: null,
  });
  expect(model.embed).not.toHaveBeenCalled();
});
