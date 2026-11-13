import { Database } from "./db.js";
import type { Project } from "../shared/types.js";
import { GitHub } from "./github.js";
import { HttpEmbedder, type Embedder } from "./embedder.js";
import { archiveChunksWithStats, type FileChunk } from "./repo-chunks.js";
import { fileVectors } from "./repo-vectors.js";

export type ProjectBase = { id: string; sha: string };
type Target = { project_id: string; wanted_sha: string; generation: string };
const enabled =
  "(SELECT (value->>'rag_enabled')::boolean FROM settings WHERE id=1)";
export async function scheduleRepoIndex(db: Database, p: Project, sha: string) {
  if (
    await db.one(
      "SELECT 1 FROM repo_indexes WHERE project_id=$1 AND wanted_sha=$2",
      [p.id, sha],
    )
  )
    return;
  await db.transaction(async (c) => {
    // 先與解除綁定或更改環境的交易同步，再檢查目前的綁定。
    const project = await c.query(
      "SELECT 1 FROM projects WHERE id=$1 AND config_version=$2 AND validated_at IS NOT NULL FOR UPDATE",
      [p.id, p.config_version],
    );
    if (!project.rowCount) return;
    const changed = await c.query(
      `INSERT INTO repo_indexes(project_id,wanted_sha,phase)
      SELECT $1,$2,'queued' WHERE ${enabled} AND EXISTS(SELECT 1 FROM group_projects WHERE project_id=$1)
      ON CONFLICT(project_id) DO UPDATE SET wanted_sha=excluded.wanted_sha,generation=gen_random_uuid(),
      phase=CASE WHEN repo_indexes.active_sha=excluded.wanted_sha THEN 'ready' ELSE 'queued' END,error=NULL,retry_at=now(),total_chunks=NULL,truncated=false
      WHERE repo_indexes.wanted_sha IS DISTINCT FROM excluded.wanted_sha RETURNING active_sha`,
      [p.id, sha],
    );
    if (changed.rowCount)
      await c.query(
        "DELETE FROM embeddings WHERE project_id=$1 AND kind='repo' AND sha<>$2 AND sha IS DISTINCT FROM $3",
        [p.id, sha, changed.rows[0].active_sha],
      );
  });
}

type IndexedChunk = FileChunk & { embedding: number[] };
export class RepoIndexer {
  constructor(
    private db: Database,
    private github = new GitHub(),
    private model: Embedder = new HttpEmbedder(),
  ) {}
  async work() {
    const lock = await this.db.pool.connect();
    try {
      if (
        !(await lock.query("SELECT pg_try_advisory_lock(73465) locked")).rows[0]
          .locked
      )
        return;
      const job = await this.db.one<Target>(
        `UPDATE repo_indexes SET phase='indexing',error=NULL WHERE project_id=(SELECT project_id FROM repo_indexes WHERE phase NOT IN ('ready','limited') AND retry_at<=now() AND ${enabled} ORDER BY retry_at LIMIT 1) RETURNING project_id,wanted_sha,generation`,
      );
      if (!job) return;
      let stage = "下載封存檔";
      try {
        const p = await this.db.one<Project>(
          "SELECT * FROM projects WHERE id=$1",
          [job.project_id],
        );
        const archive = await this.github.archive(p, job.wanted_sha);
        stage = "解壓與分段";
        const archiveResult = await archiveChunksWithStats(
          archive,
          p.sensitive_paths,
          5000,
          p.index_paths ?? [],
        );
        const { chunks } = archiveResult;
        if (!archiveResult.total || archiveResult.unmatchedPaths.length) {
          const reason = archiveResult.unmatchedPaths.length
            ? `索引範圍沒有可索引文字：${archiveResult.unmatchedPaths
                .slice(0, 5)
                .map((path) => path.slice(0, 160))
                .join(
                  "、",
                )}。請確認路徑、檔案類型與敏感過濾規則；未發布部分索引。`
            : "索引範圍沒有可索引文字，請確認儲存庫內容及過濾規則；未發布空索引。";
          await this.db.query(
            "UPDATE repo_indexes SET phase='failed',total_chunks=$2,truncated=false,error=$3,retry_at=now()+interval '5 minutes' WHERE generation=$1 AND " +
              enabled,
            [job.generation, archiveResult.total, reason],
          );
          return;
        }
        if (archiveResult.truncated) {
          await this.db.transaction(async (c) => {
            const changed = await c.query(
              `UPDATE repo_indexes SET phase='limited',total_chunks=$2,truncated=true,error=$3
               WHERE generation=$1 AND ${enabled} RETURNING project_id`,
              [
                job.generation,
                archiveResult.total,
                `索引超過上限：目標版本共有 ${archiveResult.total} 段，上限 ${archiveResult.limit} 段；未發布部分索引。明確需求仍可處理，請縮小索引範圍或更新專案後重建。`,
              ],
            );
            if (changed.rowCount)
              await c.query(
                "DELETE FROM embeddings WHERE kind='repo' AND project_id=$1 AND sha=$2 AND sha IS DISTINCT FROM (SELECT active_sha FROM repo_indexes WHERE project_id=$1)",
                [p.id, job.wanted_sha],
              );
          });
          return;
        }
        stage = "計算段落向量";
        const current = async () =>
          Boolean(
            await this.db.one(
              `SELECT 1 FROM repo_indexes WHERE generation=$1 AND ${enabled}`,
              [job.generation],
            ),
          );
        const batch: IndexedChunk[] = [];
        // 在交易外完成推論；最後一次交易才切換可見版本。
        for await (const chunk of fileVectors(chunks, this.model, current)) {
          batch.push(chunk);
          if (batch.length === 64) {
            if (!(await this.save(job, batch))) return;
            batch.length = 0;
          }
        }
        if (batch.length && !(await this.save(job, batch))) return;
        await this.db.transaction(async (c) => {
          const ready = await c.query(
            `UPDATE repo_indexes SET active_sha=wanted_sha,chunks=$2,total_chunks=$2,truncated=false,phase='ready',error=NULL WHERE generation=$1 AND ${enabled} AND $2=(SELECT count(*) FROM embeddings WHERE kind='repo' AND project_id=$3 AND sha=$4) RETURNING project_id`,
            [job.generation, chunks.length, p.id, job.wanted_sha],
          );
          if (ready.rowCount)
            await c.query(
              "DELETE FROM embeddings WHERE kind='repo' AND project_id=$1 AND sha<>$2",
              [p.id, job.wanted_sha],
            );
        });
      } catch (error) {
        const diagnostic =
          error instanceof Error
            ? error.message.match(
                /GitHub App 尚未完成設定|HTTP \d{3}|逾時（30 秒）|無法連線到本機向量模型|下載專案封存檔失敗（\d{3}）|封存檔連線逾時（60 秒）|封存檔傳輸停滯（60 秒未收到資料）|封存檔下載超過 30 分鐘/u,
              )?.[0]
            : undefined;
        await this.db.query(
          "UPDATE repo_indexes SET phase='failed',error=$2,retry_at=now()+interval '5 minutes' WHERE generation=$1",
          [
            job.generation,
            stage +
              "失敗" +
              (diagnostic ? "（" + diagnostic + "）" : "") +
              "，五分鐘後重試",
          ],
        );
      }
    } finally {
      try {
        await lock.query("SELECT pg_advisory_unlock(73465)");
      } finally {
        lock.release();
      }
    }
  }
  private async save(job: Target, items: IndexedChunk[]) {
    return this.db.transaction(async (c) => {
      const active = await c.query(
        `SELECT project_id FROM repo_indexes WHERE generation=$1 AND ${enabled} FOR UPDATE`,
        [job.generation],
      );
      if (!active.rowCount) return false;
      await c.query(
        `INSERT INTO embeddings(kind,ref_id,project_id,sha,path,chunk,line_start,line_end,content,embedding)
        SELECT 'repo',$1::text||'/'||s.path,$1::uuid,$2,s.path,s.chunk,s.line_start,s.line_end,s.content,s.embedding::vector
        FROM jsonb_to_recordset($3::jsonb) s(path text,chunk int,line_start int,line_end int,content text,embedding text)
        ON CONFLICT(kind,ref_id,chunk,(coalesce(sha,''))) DO UPDATE SET embedding=excluded.embedding,content=excluded.content,line_start=excluded.line_start,line_end=excluded.line_end`,
        [
          job.project_id,
          job.wanted_sha,
          JSON.stringify(
            items.map((i) => ({
              ...i,
              embedding: JSON.stringify(i.embedding),
            })),
          ),
        ],
      );
      return true;
    });
  }
}
type FileHit = {
  path: string;
  line_start: number;
  line_end: number;
  content: string;
  score: number;
  sha: string;
};
export async function relevantFiles(
  db: Database,
  group: string,
  bases: ProjectBase[],
  query: string,
  vector: number[],
) {
  const files: Record<string, FileHit[]> = {};
  if (!bases.length) return files;
  const tokens = [
    ...new Set(query.toLowerCase().match(/[a-z][a-z0-9]{1,39}/g) ?? []),
  ].slice(0, 64);
  // 分開中文兩側的英文詞組；精確欄名可優先於只有共同路徑詞的頁首。
  // 只產生有限長度的英數詞組，SQL 不接收任意正規表示式。
  const phrases = [
    ...new Set(
      (
        query
          .toLowerCase()
          .match(/[a-z][a-z0-9]{1,39}(?:[ \t]+[a-z][a-z0-9]{1,39})+/g) ?? []
      ).flatMap((run) => {
        const parts = run.split(/[ \t]+/).slice(0, 64);
        return parts.flatMap((_, start) =>
          [2, 3, 4]
            .filter((length) => start + length <= parts.length)
            .map((length) => parts.slice(start, start + length).join(" ")),
        );
      }),
    ),
  ].slice(0, 32);
  // 保留向量分數；路徑詞按不同詞的匹配數加分，總加分不高於原本的0.32。
  const aliases = new Set<string>();
  for (const [label, words] of Object.entries({
    看板: ["kanban", "dashboard"],
    即時: ["live", "realtime", "current", "cur"],
    報表: ["report", "reports"],
    登入: ["login", "signin"],
    匯出: ["export"],
    排程: ["schedule"],
  }))
    if (query.includes(label)) words.forEach((w) => aliases.add(w));
  const words = [
    ...new Intl.Segmenter("zh-TW", { granularity: "word" }).segment(
      query.toLowerCase(),
    ),
  ]
    .filter((s) => s.isWordLike && s.segment.length >= 2)
    .map((s) => s.segment)
    .slice(0, 32);
  const rows = await db.query<FileHit & { id: string; score: number }>(
    `WITH scored AS (
    SELECT e.project_id AS id,e.path,e.line_start,e.line_end,e.content,e.sha,
      greatest(1-(e.embedding <=> $3::vector),CASE WHEN EXISTS(SELECT 1 FROM unnest($6::text[]) word WHERE strpos(lower(e.content),word)>0) THEN 0.45 ELSE 0 END)
      + 0.08 * least(4,(SELECT count(*) FROM unnest($4::text[]) word WHERE word=ANY(regexp_split_to_array(lower(e.path),'[^a-z0-9]+'))))
      + 0.16 * (SELECT count(*) FROM unnest($5::text[]) synonym WHERE synonym=ANY(regexp_split_to_array(lower(e.path),'[^a-z0-9]+')))
      + CASE WHEN EXISTS(SELECT 1 FROM unnest($7::text[]) phrase WHERE lower(e.content) ~ ('(^|[^a-z0-9])'||replace(phrase,' ','[[:space:]]+')||'([^a-z0-9]|$)')) THEN 0.24 ELSE 0 END AS score
    FROM jsonb_to_recordset($2::jsonb) b(id uuid,sha text)
    JOIN group_projects gp ON gp.project_id=b.id AND gp.group_id=$1
    JOIN repo_indexes r ON r.project_id=b.id AND r.active_sha=b.sha
    JOIN embeddings e ON e.kind='repo' AND e.project_id=r.project_id AND e.sha=r.active_sha
  ), per_file AS (SELECT *,row_number() OVER(PARTITION BY id,path ORDER BY score DESC,line_start) part FROM scored), ranked AS (SELECT *,row_number() OVER(PARTITION BY id ORDER BY score DESC,path,line_start) pos,max(score) OVER() best FROM per_file WHERE part<=2)
  SELECT id,path,line_start,line_end,content,score,sha FROM ranked WHERE pos<=5 AND score>=0.35 AND score>=best-0.16 ORDER BY pos,score DESC,path,line_start`,
    [
      group,
      JSON.stringify(bases),
      JSON.stringify(vector),
      tokens,
      [...aliases],
      words,
      phrases,
    ],
  );
  // 先替每個命中的專案分配段數，再縮短原文，讓前面的長片段不會擠掉其他專案。
  const ids = [...new Set(rows.map((row) => row.id))];
  const perProject = Math.max(
    3,
    Math.min(5, Math.floor(15000 / (550 * Math.max(1, ids.length)))),
  );
  const selected = ids.flatMap((id) =>
    rows.filter((row) => row.id === id).slice(0, perProject),
  );
  const overhead =
    2 + ids.reduce((sum, id) => sum + JSON.stringify(id).length + 4, 0);
  const slot =
    Math.floor((15000 - overhead) / Math.max(1, selected.length)) - 1;
  for (const { id, ...hit } of selected) {
    if (JSON.stringify(hit).length > slot) {
      const room = slot - JSON.stringify({ ...hit, content: "" }).length;
      if (room < 1) continue;
      let excerpt = hit.content.slice(0, room);
      while (JSON.stringify(excerpt).length - 2 > room)
        excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
      const newline = excerpt.lastIndexOf("\n");
      if (newline > 0) excerpt = excerpt.slice(0, newline);
      hit.content = excerpt.replace(/[\uD800-\uDBFF]$/u, "");
      if (!hit.content.trim()) continue;
      hit.line_end = hit.line_start + hit.content.split("\n").length - 1;
    }
    (files[id] ??= []).push(hit);
  }
  return files;
}
