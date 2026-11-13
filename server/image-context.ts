import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, DbClient } from "./db.js";
import { AppError } from "./policy.js";
import type { Message, Task } from "../shared/types.js";
import { modelImageContent } from "./image-content.js";

export const ImageObservation = z
  .object({
    sourceId: z.string(),
    summary: z.string().max(3000),
    text: z.string().max(8000),
    uncertainties: z.array(z.string().max(500)).max(12),
    intent: z.enum(["reference", "change_request", "uncertain"]),
  })
  .strict();
export type ImageObservationDraft = z.infer<typeof ImageObservation>;
export const imageHash = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const imageLimits = { count: 6, bytes: 30 * 1024 * 1024 };
export interface TaskImage {
  id: string;
  mime: string;
  originalMime: string;
  data: string;
  sha256: string;
  modelSha256: string;
  origin: "direct" | "rag";
  observationId: string | null;
}

export async function saveImageObservations(
  c: DbClient,
  messages: Message[],
  drafts: ImageObservationDraft[],
) {
  for (const raw of drafts) {
    const d = ImageObservation.parse(raw);
    const source = messages.find(
      (m) => m.id === d.sourceId && m.type === "image" && m.image,
    );
    if (!source || source.contextOrigin === "rag")
      throw new AppError(422, "圖片觀察來源不屬於本次新辨識圖片");
    const saved = await c.query(
      `INSERT INTO image_observations(message_id,group_id,source_hash,summary,recognized_text,uncertainties,intent,source_at)
      SELECT id,group_id,$2,$3,$4,$5,$6,received_at FROM messages WHERE id=$1 AND group_id=$7 AND NOT revoked
      AND received_at>message_retention_cutoff() AND encode(sha256(image),'hex')=$2
      ON CONFLICT(message_id) DO UPDATE SET source_hash=excluded.source_hash,summary=excluded.summary,recognized_text=excluded.recognized_text,
        id=gen_random_uuid(),uncertainties=excluded.uncertainties,intent=excluded.intent,source_at=excluded.source_at,updated_at=now() RETURNING message_id`,
      [
        source.id,
        imageHash(source.image!),
        d.summary,
        d.text,
        JSON.stringify(d.uncertainties),
        d.intent,
        source.group_id,
      ],
    );
    if (!saved.rowCount)
      throw new AppError(409, "圖片觀察來源已改變，請重新辨識");
  }
}

export async function saveTaskImageRefs(
  c: DbClient,
  task: Pick<Task, "id" | "version" | "group_id" | "source_ids">,
  messages: Message[],
) {
  for (const m of messages.filter(
    (m) => task.source_ids.includes(m.id) && m.type === "image" && m.image,
  )) {
    const saved = await c.query(
      `INSERT INTO task_image_refs(task_id,task_version,message_id,source_hash,mime,origin,observation_id)
      SELECT $1,$2,m.id,$4,m.image_mime,$5,o.id FROM messages m LEFT JOIN image_observations o ON o.message_id=m.id AND o.source_hash=$4
      WHERE m.id=$3 AND m.group_id=$6 AND NOT m.revoked AND m.received_at>message_retention_cutoff() AND encode(sha256(m.image),'hex')=$4
      ON CONFLICT(task_id,task_version,message_id) DO NOTHING RETURNING message_id`,
      [
        task.id,
        task.version,
        m.id,
        imageHash(m.image!),
        m.contextOrigin ?? "direct",
        task.group_id,
      ],
    );
    if (
      !saved.rowCount &&
      !(
        await c.query(
          "SELECT 1 FROM task_image_refs WHERE task_id=$1 AND task_version=$2 AND message_id=$3 AND source_hash=$4",
          [task.id, task.version, m.id, imageHash(m.image!)],
        )
      ).rowCount
    )
      throw new AppError(409, "圖片來源已失效，請重新辨識");
  }
}

async function refs(
  db: Database,
  taskId: string,
  version: number,
  bytes: boolean,
) {
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [taskId]);
  if (!task || task.version !== version)
    throw new AppError(409, "圖片需求版本已更新");
  const rows = await db.query<{
    id: string;
    mime: string;
    sha256: string;
    origin: "direct" | "rag";
    observationId: string | null;
    valid: boolean;
    reason: string;
    image?: Buffer;
    size: number;
    observation: ImageObservationDraft | null;
  }>(
    `SELECT r.message_id AS id,r.mime,r.source_hash AS sha256,r.origin,r.observation_id AS "observationId",
    (${bytes ? "m.image" : "NULL::bytea"}) AS image,coalesce(octet_length(m.image),0) AS size,
    (t.version=$2 AND EXISTS(SELECT 1 FROM groups g WHERE g.id=t.group_id AND g.enabled)
      AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=t.group_id AND gp.project_id=t.project_id))
      AND m.id IS NOT NULL AND m.group_id=t.group_id AND m.id=ANY(t.source_ids) AND NOT m.revoked AND m.received_at>message_retention_cutoff()
      AND m.image IS NOT NULL AND m.image_mime=r.mime AND encode(sha256(m.image),'hex')=r.source_hash) AS valid,
    CASE WHEN t.version<>$2 THEN '圖片需求版本已更新'
      WHEN NOT EXISTS(SELECT 1 FROM groups g WHERE g.id=t.group_id AND g.enabled)
      OR (t.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=t.group_id AND gp.project_id=t.project_id)) THEN '群組或專案綁定已停用'
      WHEN m.id IS NULL OR m.group_id<>t.group_id OR NOT(m.id=ANY(t.source_ids)) THEN '來源不屬於此需求'
      WHEN m.revoked THEN '圖片已撤回' WHEN m.received_at<=message_retention_cutoff() THEN '圖片已到期'
      WHEN m.image IS NULL THEN '圖片尚未取得' WHEN encode(sha256(m.image),'hex')<>r.source_hash OR m.image_mime<>r.mime THEN '圖片內容已變更' ELSE '' END AS reason,
    CASE WHEN o.id=r.observation_id AND NOT m.revoked AND m.received_at>message_retention_cutoff() AND o.source_hash=r.source_hash
      THEN jsonb_build_object('sourceId',m.id,'summary',o.summary,'text',o.recognized_text,'uncertainties',o.uncertainties,'intent',o.intent) END AS observation
    FROM task_image_refs r JOIN tasks t ON t.id=r.task_id LEFT JOIN messages m ON m.id=r.message_id
    LEFT JOIN image_observations o ON o.message_id=m.id
    WHERE r.task_id=$1 AND r.task_version=$2 ORDER BY r.message_id`,
    [taskId, version],
  );
  return { task, rows };
}

export async function taskImageEvidence(
  db: Database,
  taskId: string,
  version: number,
) {
  const { rows } = await refs(db, taskId, version, false);
  return rows.map(({ image: _image, size: _size, ...row }) => ({
    ...row,
    observation: row.valid ? row.observation : null,
  }));
}

async function validRefs(
  db: Database,
  taskId: string,
  version: number,
  bytes: boolean,
) {
  const { task, rows } = await refs(db, taskId, version, bytes);
  const unbound = await db.one(
    `SELECT 1 FROM messages m WHERE m.id=ANY($1) AND m.group_id=$2 AND m.type='image'
    AND NOT EXISTS(SELECT 1 FROM task_image_refs r WHERE r.task_id=$3 AND r.task_version=$4 AND r.message_id=m.id) LIMIT 1`,
    [task.source_ids, task.group_id, taskId, version],
  );
  if (unbound)
    throw new AppError(409, "圖片來源尚未固定到需求版本，請重新辨識");
  if (rows.some((r) => !r.valid))
    throw new AppError(
      409,
      rows.find((r) => !r.valid)!.reason + "，請重新確認需求",
    );
  if (
    rows.length > imageLimits.count ||
    rows.reduce((n, r) => n + r.size, 0) > imageLimits.bytes
  )
    throw new AppError(409, "圖片超過單次處理上限，請拆分需求");
  return rows;
}
export async function validateTaskImages(
  db: Database,
  taskId: string,
  version: number,
): Promise<void> {
  await validRefs(db, taskId, version, false);
}
/** 實際採用的文字來源跟隨需求版本，候選命中不會自動成為核准來源。 */
export async function validateTaskSources(
  db: Database,
  taskId: string,
  version: number,
): Promise<void> {
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [taskId]);
  if (!task || task.version !== version)
    throw new AppError(409, "需求來源版本已更新");
  const invalid = await db.one<{ reason: string }>(
    `SELECT CASE WHEN m.id IS NULL THEN '來源訊息不存在或不屬於此群組'
    WHEN m.revoked THEN '來源訊息已撤回' WHEN m.received_at<=message_retention_cutoff() THEN '來源訊息已到期'
    ELSE '採用的歷史文字內容已變更' END AS reason
    FROM unnest($1::text[]) s(id) LEFT JOIN messages m ON m.id=s.id AND m.group_id=$2
    WHERE m.id IS NULL OR m.revoked OR m.received_at<=message_retention_cutoff()
      OR EXISTS(SELECT 1 FROM task_context_evidence e WHERE e.task_id=$3 AND e.version=$4 AND e.phase='triage-selected' AND e.source_kind='message'
        AND e.source_id=s.id AND (m.text IS NULL OR e.source_hash IS DISTINCT FROM encode(sha256(convert_to(m.text,'UTF8')),'hex'))) LIMIT 1`,
    [task.source_ids, task.group_id, taskId, version],
  );
  if (invalid) throw new AppError(409, invalid.reason + "，請重新確認需求");
}
export async function getTaskImages(
  db: Database,
  taskId: string,
  version: number,
): Promise<TaskImage[]> {
  return Promise.all(
    (await validRefs(db, taskId, version, true)).map(async (r) => {
      const model = await modelImageContent(r.image!, r.mime);
      return {
        id: r.id,
        mime: model.mime,
        originalMime: r.mime,
        data: model.data.toString("base64"),
        sha256: r.sha256,
        modelSha256: imageHash(model.data),
        origin: r.origin,
        observationId: r.observationId,
      };
    }),
  );
}
