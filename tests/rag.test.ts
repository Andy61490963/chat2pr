import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { GitHub } from "../server/github.js";
import { db, reset, session } from "./helpers.js";
import type { Embedder } from "../server/embedder.js";

beforeEach(reset);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

it("升級預設關閉；重跑遷移保留開關與既有設定", async () => {
  await db.query("UPDATE settings SET value=value - 'rag_enabled'");
  await db.migrate();
  expect((await db.settings()).rag_enabled).toBe(false);
  await db.query(
    `UPDATE settings SET value=value || '{"rag_enabled":true}'::jsonb`,
  );
  const before = await db.settings();
  await db.migrate();
  expect(await db.settings()).toEqual(before);
});

it("資料庫限制種類、維度、原文與重複索引", async () => {
  const v = JSON.stringify(Array(1024).fill(1));
  const insert = (kind: string, content: string | null, embedding = v) =>
    db.query(
      "INSERT INTO embeddings(kind,ref_id,content,embedding) VALUES($1,'測試來源',$2,$3)",
      [kind, content, embedding],
    );
  await insert("message", null);
  await expect(insert("message", null)).rejects.toMatchObject({
    code: "23505",
  });
  for (const kind of ["message", "task", "memory", "knowledge", "未知"]) {
    await expect(insert(kind, "原文")).rejects.toMatchObject({ code: "23514" });
  }
  await insert("repo", "專案片段");
  await insert("outcome", "任務摘要");
  await expect(insert("task", null, "[1]")).rejects.toThrow(/dimension/i);
});

it("管理者可啟用健康檢查；舊版設定保留開關，停用時略過推論", async () => {
  vi.spyOn(GitHub.prototype, "repos").mockResolvedValue([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
  const model: Embedder = {
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) => Array<number>(1024).fill(t.length)),
    ),
  };
  const app = await buildApp(db, undefined, model);
  try {
    const headers = await session();
    const check = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/check",
          headers,
        })
      ).json();
    const settings = {
      ...(await db.settings()),
      paused: true,
      codex_model: null,
      triage_effort: "high",
      coding_effort: "medium",
    };
    const save = (body: object) =>
      app.inject({
        method: "PUT",
        url: "/api/settings",
        headers,
        payload: body,
      });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload: { ...settings, rag_enabled: true },
        })
      ).statusCode,
    ).toBe(401);
    await check();
    expect(model.embed).not.toHaveBeenCalled();
    expect((await save({ ...settings, rag_enabled: true })).statusCode).toBe(
      200,
    );
    const { rag_enabled: _omit, ...legacy } = settings;
    expect((await save(legacy)).statusCode).toBe(200);
    expect(await check()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "embedder", ok: true }),
      ]),
    );
    expect(model.embed).toHaveBeenCalledExactlyOnceWith([
      "本機向量模型連線測試",
    ]);
    vi.mocked(model.embed).mockRejectedValueOnce(
      new Error("無法連線到本機向量模型"),
    );
    expect(await check()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "embedder",
          ok: false,
          detail: expect.stringContaining("無法連線"),
        }),
      ]),
    );
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await save(settings)).statusCode).toBe(200);
    await check();
    expect(model.embed).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});
