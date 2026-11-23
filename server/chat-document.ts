import { AppError } from "./policy.js";
import { maskCredentials } from "../shared/credentials.js";
import { scrubConnectionSecrets } from "./secret-scrub.js";
import type { Message, Task } from "../shared/types.js";
import type { Line } from "./line.js";
import type { Database } from "./db.js";
import { discordImageUrl } from "./chat-image.js";
import { extractDocumentText, MAX_DOCUMENT_BYTES, supportsDocument } from "./document-text.js";

type ContentSource = Pick<Line, "content">;
const tooLarge = "文件超過 8 MiB，請拆分後重新上傳";
const unavailable = "無法下載文件，請重新上傳";
export const documentsPerTask = 4;

async function download(line: ContentSource, m: Message) {
  let response: Response;
  if (m.id.startsWith("discord:")) {
    const url = discordImageUrl(m.document_url ?? "");
    if (!url) throw new Error(unavailable);
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  } else {
    response = await line.content(m.id);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(unavailable);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) throw new Error(tooLarge);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error(tooLarge);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// 背景取件與即時引用可能同時讀同一附件。只在資料仍屬同一來源版本時寫回。
export async function loadChatDocument(db: Database, line: ContentSource, m: Message) {
  if (m.text || m.document_error) return;
  const revision = m.content_revision ?? 0;
  const where = "id=$1 AND content_revision=$2 AND type='document' AND NOT revoked AND received_at>message_retention_cutoff()";
  const name = m.document_name ?? "";
  let text: string | null = null;
  let error: string | null = null;
  if (!supportsDocument(name)) error = "不支援此文件格式，請轉成文字、PDF 或新版 Office 文件";
  else if (Number(m.document_size) > MAX_DOCUMENT_BYTES) error = tooLarge;
  else {
    try {
      const data = await download(line, m);
      try {
        text = maskCredentials(scrubConnectionSecrets(await extractDocumentText(name, data)));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "無法解析文件";
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message === tooLarge) error = tooLarge;
    }
  }
  // 等下載結束才扣一次額度；程序重啟或來源被撤回不會留下未完成的認領。
  // 背景與即時取件即使同時完成，也不覆寫另一邊已寫入的結果。
  await db.query(`UPDATE messages SET text=$3,content_attempts=content_attempts+1,
    document_error=CASE WHEN $3::text IS NULL AND $4::text IS NULL AND content_attempts>=2 THEN $5 ELSE $4 END
    WHERE ${where} AND text IS NULL AND document_error IS NULL AND document_url IS NOT DISTINCT FROM $6::text`,
    [m.id, revision, text, error, unavailable, m.document_url ?? null]);
  const result = await db.one<{ text: string | null; document_error: string | null }>(
    `SELECT text,document_error FROM messages WHERE ${where}`, [m.id, revision]);
  m.text = result?.text ?? null;
  m.document_error = result ? result.document_error : "文件已撤回、變更或到期";
}

export async function taskDocuments(db: Database, task: Task) {
  const rows = await db.query<{name: string; text: string}>(
    `SELECT document_name AS name,text FROM messages WHERE id=ANY($1) AND group_id=$2
     AND discord_thread_id IS NOT DISTINCT FROM $3::text AND type='document' AND text IS NOT NULL
     AND NOT revoked AND received_at>message_retention_cutoff() ORDER BY received_at,id LIMIT $4`,
    [task.source_ids, task.group_id, task.discord_thread_id ?? null, documentsPerTask + 1]);
  if (rows.length > documentsPerTask) throw new AppError(422, "任務附件超過四份，請拆分需求");
  return rows;
}
