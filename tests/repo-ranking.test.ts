import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, fixture, reset } from "./helpers.js";
import { relevantFiles } from "../server/repo-index.js";

beforeEach(reset);
afterAll(() => db.close());
const queryVector = [1, ...Array<number>(1023).fill(0)];
const vector = (similarity: number) => [
  similarity,
  Math.sqrt(1 - similarity ** 2),
  ...Array<number>(1022).fill(0),
];
async function ready(id: string, sha = "ranking-v1") {
  await db.query(
    "INSERT INTO repo_indexes(project_id,wanted_sha,active_sha,phase) VALUES($1,$2,$2,'ready')",
    [id, sha],
  );
}
async function chunk(
  id: string,
  path: string,
  line: number,
  content: string,
  similarity = 0.6,
  sha = "ranking-v1",
) {
  await db.query(
    `INSERT INTO embeddings(kind,ref_id,project_id,sha,chunk,path,line_start,line_end,content,embedding)
     VALUES('repo',$1,$2,$3,$4,$5,$4,$6,$7,$8::vector)`,
    [
      `${id}:${path}`,
      id,
      sha,
      line,
      path,
      line + content.split("\n").length - 1,
      content,
      JSON.stringify(vector(similarity)),
    ],
  );
}
const read = (
  ids: string[],
  query: string,
  group = "group-a",
  sha = "ranking-v1",
) =>
  relevantFiles(
    db,
    group,
    ids.map((id) => ({ id, sha })),
    query,
    queryVector,
  );

describe("專案片段精確名稱與路徑排名", () => {
  it("指定L1與Part Spec時優先取實際欄名片段，避免只取頁首與其他層看板", async () => {
    const id = await fixture();
    await ready(id);
    const l1 = "wwwroot/wwwroot/Dashboard/WIP/L1/CUR.html";
    await chunk(id, l1, 1, "<html><head><title>即時看板</title></head>", 0.556);
    await chunk(id, l1, 40, "<table>\n<th>Part Spec</th>\n</table>", 0.43);
    await chunk(
      id,
      "wwwroot/wwwroot/Dashboard/WIP/L1/CUR.css",
      134,
      ".machine-table{width:100%}",
      0.55,
    );
    await chunk(
      id,
      "wwwroot/wwwroot/Dashboard/WIP/L1/CUR.css",
      343,
      ".machine-table th{font-weight:bold}",
      0.549,
    );
    await chunk(
      id,
      "wwwroot/wwwroot/Dashboard/WIP/L0/CUR.html",
      1,
      "<title>即時看板</title>",
      0.57,
    );
    await chunk(
      id,
      "wwwroot/wwwroot/Dashboard/WIP/L2/CUR.html",
      1,
      "<title>即時看板</title>",
      0.569,
    );
    const hits = (await read([id], "WIP L1 CUR 即時看板 Part Spec 欄位"))[id];
    expect(hits[0]).toMatchObject({
      path: l1,
      line_start: 40,
      sha: "ranking-v1",
    });
    expect(hits[0].content).toContain("Part Spec");
    expect(hits.some((h) => h.path.endsWith("L1/CUR.css"))).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it("命中多個明確路徑詞優先，重複查詢詞不重複加分", async () => {
    const id = await fixture();
    await ready(id);
    await chunk(id, "WIP/L0/CUR.html", 1, "<h1>畫面</h1>");
    await chunk(id, "WIP/L1/CUR.html", 1, "<h1>畫面</h1>");
    const hits = (await read([id], "WIP L1 CUR"))[id];
    expect(hits[0].path).toBe("WIP/L1/CUR.html");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    const repeat = (await read([id], "WIP WIP L1 CUR"))[id];
    expect(repeat.map((h) => [h.path, h.score])).toEqual(
      hits.map((h) => [h.path, h.score]),
    );
  });

  it("精確英文詞組不以部分單字代替，換行與大小寫仍能對應", async () => {
    const id = await fixture();
    await ready(id);
    await chunk(id, "src/a.html", 1, "<th>Part Specification</th>", 0.7);
    await chunk(id, "src/b.html", 15, "<th>PART\n  SPEC</th>", 0.55);
    const hits = (await read([id], "請修改 Part Spec 欄位"))[id];
    expect(hits[0].path).toBe("src/b.html");
    const repeat = (await read([id], "請修改 Part Spec Part Spec 欄位"))[id];
    expect(repeat[0].score).toBeCloseTo(hits[0].score);
  });

  it("純中文且無路徑詞時保留向量排序，不強迫英文匹配", async () => {
    const id = await fixture();
    await ready(id);
    await chunk(id, "src/a.html", 1, "甲內容", 0.75);
    await chunk(id, "src/b.html", 1, "乙內容", 0.65);
    const hits = (await read([id], "請修正顯示錯誤"))[id];
    expect(hits.map((h) => h.path)).toEqual(["src/a.html", "src/b.html"]);
    expect(hits[0].score).toBeCloseTo(0.75);
  });

  it("同欄名跨專案保留各自來源，異群／錯SHA／解除綁定不能靠高詞分進入", async () => {
    const a = await fixture();
    await ready(a);
    const b = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('乙專案','test/ranking-b',true,now()) RETURNING id",
    );
    await ready(b.id);
    await db.query(
      "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
      [b.id],
    );
    await chunk(a, "src/shared.html", 1, "Part Spec：甲專案", 0.6);
    await chunk(b.id, "src/shared.html", 1, "Part Spec：乙專案", 0.6);
    const hits = await read([a, b.id], "Part Spec");
    expect(Object.keys(hits).sort()).toEqual([a, b.id].sort());
    expect(hits[a][0].content).toContain("甲專案");
    expect(hits[b.id][0].content).toContain("乙專案");
    expect(await read([a, b.id], "Part Spec", "other-group")).toEqual({});
    expect(await read([a, b.id], "Part Spec", "group-a", "stale-sha")).toEqual(
      {},
    );
    await db.query(
      "DELETE FROM group_projects WHERE group_id='group-a' AND project_id=$1",
      [b.id],
    );
    expect(Object.keys(await read([a, b.id], "Part Spec"))).toEqual([a]);
  });

  it("高詞分不繞過每檔2段、個別專案分配及序列化15000字元上限", async () => {
    await fixture();
    const ids: string[] = [];
    for (let p = 0; p < 6; p++) {
      const { id } = await db.one<{ id: string }>(
        "INSERT INTO projects(name,repo,enabled,validated_at) VALUES($1,$2,true,now()) RETURNING id",
        [`專案${p}`, `test/rank-${p}`],
      );
      ids.push(id);
      await ready(id);
      await db.query(
        "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
        [id],
      );
      for (let file = 0; file < 3; file++)
        for (let part = 0; part < 3; part++)
          await chunk(
            id,
            `src/field-${file}.html`,
            part * 100 + 1,
            `Shared Spec 專案${p}\n` + Array(120).fill('欄位"文字').join("\n"),
            0.8,
          );
    }
    const result = await read(ids, "Shared Spec 欄位");
    expect(Object.keys(result)).toHaveLength(6);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(15000);
    for (const [id, hits] of Object.entries(result)) {
      expect(hits.length).toBeGreaterThanOrEqual(3);
      expect(hits.length).toBeLessThanOrEqual(5);
      for (const path of new Set(hits.map((h) => h.path)))
        expect(hits.filter((h) => h.path === path).length).toBeLessThanOrEqual(
          2,
        );
      expect(
        hits.every(
          (h) =>
            h.sha === "ranking-v1" &&
            h.content.includes(`專案${ids.indexOf(id)}`),
        ),
      ).toBe(true);
    }
  });
});
