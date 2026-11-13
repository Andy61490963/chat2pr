import { containsRepositoryCredential } from "./repository-safety.js";
import { redact } from "./policy.js";
import { relevantFiles, type ProjectBase } from "./repo-index.js";
import { Database, type DbClient } from "./db.js";
import { HttpEmbedder, type Embedder } from "./embedder.js";
import { recordContextEvidence } from "./task-context.js";
import type { ContextEvidenceInput } from "../shared/context-evidence.js";

type Kind = "message" | "task" | "memory" | "knowledge" | "image";
export type Hit = {
  kind: Kind;
  id: string;
  project_id: string | null;
  content: string;
  source_time: Date;
  score: number;
  source_hash?: string;
};
export type Lookup = {
  hits: Hit[];
  reason: string;
  files?: Awaited<ReturnType<typeof relevantFiles>>;
  contextEvidence?: ContextEvidenceInput[];
  omittedImageCandidates?: string[];
  contextLimits?: Record<
    string,
    {
      limit: number;
      truncated: boolean;
      omittedIds?: string[];
      total?: number;
      indexed?: number;
      sha?: string;
      available?: boolean;
      reason?: string;
    }
  >;
};
type Pending = {
  kind: Kind | "outcome";
  ref_id: string;
  ticket: string;
  content: string | null;
};
const enabled =
  "(SELECT (value->>'rag_enabled')::boolean FROM settings WHERE id=1)";

function outcomeSummary(text: string) {
  const clean = redact(text);
  return containsRepositoryCredential(clean) ? "摘要含憑證，已省略" : clean;
}

async function finishBackfill(db: Database) {
  const done = await db.query(
    "UPDATE rag_backfill SET active=false,completed_at=now() WHERE active AND NOT EXISTS(SELECT 1 FROM rag_pending WHERE backfill) RETURNING id",
  );
  if (!done.length) return;
  await db.audit(null, "rag", "補建索引完成");
  // 補建完成也算一次確認，設定頁的「向量索引」時間才不會停在更早的日期。
  await db.query(
    "UPDATE service_health SET checked_at=now() WHERE name='rag_index' AND ok",
  );
}
// 上下文截斷寫成白話放進時間軸，讓人看得出判讀時少看了什麼，不顯示原始 JSON。
export function describeLimits(limits: Lookup["contextLimits"]) {
  if (!limits) return "";
  const notes: string[] = [];
  for (const [key, l] of Object.entries(limits)) {
    if (key === "recentConversation" && l.truncated)
      notes.push(`近期對話只取最近 ${l.limit} 則`);
    else if (key === "existingTasks" && l.truncated)
      notes.push(`既有任務只取最近 ${l.limit} 個`);
    else if (key === "imageCandidates" && l.truncated)
      notes.push(`${l.omittedIds?.length ?? 0} 張候選圖片超過上限未提供`);
    else if (key.startsWith("repo:")) {
      if (l.truncated)
        notes.push(
          `程式索引超過上限（共 ${l.total ?? "?"} 段，上限 ${l.limit}）`,
        );
      if (l.available === false)
        notes.push(`程式索引暫不可用${l.reason ? `（${l.reason}）` : ""}`);
    }
  }
  return notes.length ? `；上下文有截斷：${notes.join("、")}` : "";
}
export async function requestBackfill(db: Database) {
  await db.transaction(async (c) => {
    const current = await c.query(
      "SELECT active FROM rag_backfill WHERE id FOR UPDATE",
    );
    if (current.rows[0].active) return;
    await c.query(`INSERT INTO rag_pending(kind,ref_id,backfill)
      SELECT s.kind,s.ref_id,true FROM rag_sources s WHERE NOT EXISTS
      (SELECT 1 FROM embeddings e WHERE e.kind=s.kind AND e.ref_id=s.ref_id)
      ON CONFLICT(kind,ref_id) DO UPDATE SET backfill=true`);
    await c.query("UPDATE rag_backfill SET active=true WHERE id");
    await db.audit(null, "rag", "已排程補建索引", c);
  });
  await finishBackfill(db);
}

export class Retrieval {
  constructor(
    private db: Database,
    private model: Embedder = new HttpEmbedder(),
  ) {}
  private async health(
    name: "retrieval" | "rag_index" | "outcomes",
    ok: boolean,
    detail: string,
  ) {
    await this.db.query(
      `INSERT INTO service_health(name,ok,detail) VALUES($3,$1,$2)
      ON CONFLICT(name) DO UPDATE SET ok=excluded.ok,detail=excluded.detail,checked_at=now() WHERE service_health.ok IS DISTINCT FROM excluded.ok OR service_health.detail IS DISTINCT FROM excluded.detail OR service_health.checked_at<now()-interval '10 minutes'`,
      [ok, detail, name],
    );
  }
  async indexBatch() {
    const batch = await this.db
      .query<Pending>(`SELECT p.kind,p.ref_id,p.ticket,left(s.content,20000) content FROM
      (SELECT * FROM rag_pending WHERE available_at<=now() AND (backfill OR ${enabled})
       ORDER BY available_at,kind,ref_id LIMIT 16) p
      LEFT JOIN rag_sources s USING(kind,ref_id) ORDER BY p.available_at,p.kind,p.ref_id`);
    const live = batch.filter((row) => row.content !== null);
    let vectors: number[][] = [];
    if (live.length) {
      try {
        vectors = await this.model.embed(
          live.map((row) =>
            row.kind === "outcome"
              ? outcomeSummary(row.content!)
              : row.content!,
          ),
        );
      } catch (error) {
        await this.db.query(
          "UPDATE rag_pending SET available_at=now()+interval '1 minute' WHERE ticket=ANY($1::uuid[])",
          [live.map((row) => row.ticket)],
        );
        await this.health("rag_index", false, "索引計算失敗，將自動重試");
        throw error;
      }
    }
    let i = 0;
    await this.db.transaction(async (c) => {
      for (const row of batch) {
        const vector = row.content === null ? undefined : vectors[i++];
        // 認領同一版本的工作。推論期間若來源被撤回或修改，捨棄舊結果。
        const claim = await c.query(
          "DELETE FROM rag_pending WHERE kind=$1 AND ref_id=$2 AND ticket=$3 AND (backfill OR " +
            enabled +
            ") RETURNING ticket",
          [row.kind, row.ref_id, row.ticket],
        );
        if (!claim.rowCount || !vector) continue;
        await c.query(
          `INSERT INTO embeddings(kind,ref_id,group_id,project_id,embedding,content)
          SELECT kind,ref_id,group_id,project_id,$3::vector,$4 FROM rag_sources WHERE kind=$1 AND ref_id=$2
          ON CONFLICT(kind,ref_id,chunk,(coalesce(sha,''))) DO UPDATE SET embedding=excluded.embedding,content=excluded.content,group_id=excluded.group_id,project_id=excluded.project_id,created_at=now()`,
          [
            row.kind,
            row.ref_id,
            JSON.stringify(vector),
            row.kind === "outcome" ? outcomeSummary(row.content!) : null,
          ],
        );
      }
    });
    if (live.length) await this.health("rag_index", true, "索引計算正常");
    await finishBackfill(this.db);
    return batch.length;
  }
  async pastOutcomes(
    task: {
      target_branch?: string | null;
      id: string;
      project_id: string | null;
      group_id: string;
      title: string;
      summary: string;
    },
    active: boolean,
  ): Promise<
    { taskId: string; summary: string; score?: number; source_time?: Date }[]
  > {
    if (!active || !task.project_id) return [];
    const eligible = `FROM embeddings e JOIN tasks t ON t.id::text=e.ref_id AND t.project_id=e.project_id
      JOIN group_projects source ON source.group_id=t.group_id AND source.project_id=t.project_id
      JOIN group_projects target ON target.group_id=$3 AND target.project_id=e.project_id
      WHERE e.kind='outcome' AND e.project_id=$1 AND t.id<>$2 AND t.target_branch=coalesce($4,(SELECT base_branch FROM projects WHERE id=$1)) AND t.status IN ('failed','ready','merged') AND ${enabled}`;
    const scope = [
      task.project_id,
      task.id,
      task.group_id,
      task.target_branch ?? null,
    ];
    try {
      if (!(await this.db.one("SELECT 1 " + eligible + " LIMIT 1", scope)))
        return [];
      const [v] = await this.model.embed([
        (task.title + "\n" + task.summary).slice(0, 4000),
      ]);
      const rows = await this.db.query<{
        taskId: string;
        summary: string;
        score: number;
        source_time: Date;
      }>(
        'SELECT e.ref_id AS "taskId",e.content AS summary,1-(e.embedding <=> $5::vector) AS score,t.updated_at AS source_time ' +
          eligible +
          " ORDER BY e.embedding <=> $5::vector,e.ref_id LIMIT 3",
        [...scope, JSON.stringify(v)],
      );
      await this.health("outcomes", true, "已檢索同專案任務結果");
      return rows;
    } catch {
      await this.health("outcomes", false, "經驗檢索失敗，繼續執行本次需求");
      return [];
    }
  }
  async lookup(
    group: string,
    query: string,
    exclude: string[],
    projects: string[],
    active: boolean,
    bases: ProjectBase[] = [],
  ): Promise<Lookup> {
    if (!active || !query.trim()) {
      const reason = active ? "沒有可供檢索的文字" : "未啟用";
      await this.health("retrieval", true, reason);
      return { hits: [], reason };
    }
    try {
      const [vector] = await this.model.embed([query]);
      const rows = await this.db.query<Hit>(
        `WITH ranked AS (
        SELECT s.kind,s.ref_id AS id,s.project_id,left(s.content,20000) AS content,s.source_time,
        CASE WHEN s.kind='message' THEN encode(sha256(convert_to(s.content,'UTF8')),'hex') WHEN s.kind='image' THEN o.source_hash END AS source_hash,
        1-(e.embedding <=> $2::vector) + 0.02/(1+greatest(0,extract(epoch FROM now()-s.source_time))/86400) AS score
        FROM embeddings e JOIN rag_sources s ON s.kind=e.kind AND s.ref_id=e.ref_id
        LEFT JOIN image_observations o ON s.kind='image' AND o.message_id=s.ref_id
        WHERE s.kind IN ('message','memory','knowledge','task','image') AND (s.group_id=$1 OR s.kind='knowledge') AND (s.project_id IS NULL OR (s.project_id=ANY($4::uuid[])
        AND EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=$1 AND gp.project_id=s.project_id)))
        AND (s.kind NOT IN ('message','image') OR NOT(s.ref_id=ANY($3::text[])))
      ), bounded AS (SELECT *,row_number() OVER(PARTITION BY kind ORDER BY score DESC,id) AS n FROM ranked)
      SELECT kind,id,project_id,content,source_time,score,source_hash FROM bounded WHERE n<=CASE kind WHEN 'message' THEN 20 WHEN 'task' THEN 10 WHEN 'image' THEN 4 ELSE 5 END
      AND (kind<>'image' OR score>=0.45)
      ORDER BY score DESC,kind,id`,
        [group, JSON.stringify(vector), exclude, projects],
      );
      const hits: Hit[] = [];
      const imageCandidates = rows.filter((r) => r.kind === "image");
      const omittedImageCandidates = imageCandidates.slice(3).map((r) => r.id);
      let remaining = 20000 - 2;
      for (const row of rows) {
        if (omittedImageCandidates.includes(row.id) && row.kind === "image")
          continue;
        const overhead = JSON.stringify({ ...row, content: "" }).length + 1;
        if (remaining <= overhead) break;
        let content = row.content.slice(
          0,
          Math.min(4000, remaining - overhead),
        );
        while (JSON.stringify(content).length - 2 > remaining - overhead)
          content = content.slice(0, Math.floor(content.length * 0.9));
        hits.push({ ...row, content });
        remaining -= JSON.stringify(hits[hits.length - 1]).length + 1;
      }
      const files = await relevantFiles(this.db, group, bases, query, vector);
      for (const row of imageCandidates)
        if (
          !hits.some((h) => h.kind === "image" && h.id === row.id) &&
          !omittedImageCandidates.includes(row.id)
        )
          omittedImageCandidates.push(row.id);
      await this.health("retrieval", true, "對話檢索正常");
      return { hits, reason: "", files, omittedImageCandidates };
    } catch {
      await this.health(
        "retrieval",
        false,
        "檢索暫時失敗，本次已使用原有判讀流程",
      );
      return { hits: [], reason: "檢索暫時失敗" };
    }
  }
}

export async function recordLookup(
  c: DbClient,
  lookup: Lookup,
  task: string | null,
  selectedIds: string[] = [],
) {
  const ids = (kind: Kind) =>
    lookup.hits.filter((h) => h.kind === kind).map((h) => h.id);
  const messages = ids("message"),
    tasks = ids("task");
  const detail =
    lookup.reason ||
    `檢索到 ${messages.length} 則舊對話、${ids("image").length} 張圖片摘要、${tasks.length} 個任務、${ids("memory").length} 條群組記憶、${ids("knowledge").length} 條專案記憶`;
  if (task)
    await recordContextEvidence(c, task, "triage", [
      ...(lookup.contextEvidence ?? []),
      ...lookup.hits.map((h) => ({
        mechanism: "vector" as const,
        source_kind: h.kind,
        source_id: h.id,
        project_id: h.project_id,
        source_time: h.source_time,
        score: h.score,
        source_hash: h.source_hash,
      })),
      ...Object.entries(lookup.files ?? {}).flatMap(([project_id, files]) =>
        files.map((f) => ({
          mechanism: "vector" as const,
          source_kind: "repo" as const,
          source_id: `${project_id}:${f.path}:${f.line_start}`,
          project_id,
          path: f.path,
          line_start: f.line_start,
          line_end: f.line_end,
          index_sha: f.sha,
          score: f.score,
        })),
      ),
    ]);
  if (task) {
    const t = (
      await c.query("SELECT source_ids FROM tasks WHERE id=$1", [task])
    ).rows[0];
    const selected = lookup.hits.filter(
      (h) =>
        ["message", "image"].includes(h.kind) &&
        t.source_ids.includes(h.id) &&
        selectedIds.includes(h.id),
    );
    await c.query(
      "DELETE FROM task_context_evidence e USING tasks t WHERE t.id=$1 AND e.task_id=t.id AND e.version=t.version AND e.phase='triage-selected' AND e.source_id=ANY($2)",
      [task, selected.map((h) => h.id)],
    );
    await recordContextEvidence(
      c,
      task,
      "triage-selected",
      selected.map((h) => ({
        mechanism: "vector",
        source_kind: h.kind,
        source_id: h.id,
        source_time: h.source_time,
        score: h.score,
        source_hash: h.source_hash,
      })),
    );
  }
  const { rows } = await c.query(
    "INSERT INTO audit(task_id,kind,detail) VALUES($1,'retrieval',$2) RETURNING id",
    [task, "判讀參考：" + detail + describeLimits(lookup.contextLimits)],
  );
  if (messages.length || tasks.length)
    await c.query(
      "INSERT INTO rag_references(audit_id,message_ids,task_ids) VALUES($1,$2,$3)",
      [rows[0].id, messages, tasks],
    );
}

export async function referencedSources(
  db: Database,
  task: string,
  group: string,
) {
  return db.query(
    `SELECT a.id,a.created_at,
    ARRAY(SELECT m.received_at FROM unnest(r.message_ids) mid JOIN messages m ON m.id=mid
      WHERE m.group_id=$2 AND NOT m.revoked AND m.text IS NOT NULL AND m.received_at>message_retention_cutoff()) messages,
    ARRAY(SELECT jsonb_build_object('id',t.id,'title',t.title) FROM unnest(r.task_ids) tid JOIN tasks t ON t.id=tid
      WHERE t.group_id=$2 AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=$2 AND gp.project_id=t.project_id))) tasks
    FROM rag_references r JOIN audit a ON r.audit_id=a.id WHERE a.task_id=$1 ORDER BY a.id DESC`,
    [task, group],
  );
}
