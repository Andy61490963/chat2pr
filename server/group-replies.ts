/**
 * 回覆提出需求的群組。管理者私訊之外，群組成員也要知道需求收到了、結果是什麼。
 *
 * 群組推播會依群組人數計入 LINE 的推播額度，所以每個群組可以選：
 * - off：不回覆群組。
 * - results：只回覆結果（查詢答案、PR 完成、合併、取消、需要人工處理）。預設。
 * - all：另外在需求整理完成、等待確認時通知。
 * 「/任務」訊息的立即回覆使用 reply token，不計入推播額度，off 以外都會回。
 */
export type ReplyMode = "off" | "results" | "all";
/** 設定頁的總開關（settings.group_replies），沒設定過視為開啟。 */
export const groupRepliesOn =
  "COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true)";
export const replyModes: ReplyMode[] = ["off", "results", "all"];

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/** 依任務所屬群組的回覆設定排入群組通知；群組已離開或設定不需要時不排。 */
export async function notifyGroup(
  c: Queryable,
  taskId: string,
  kind: string,
  key: string,
  text: string,
  level: "results" | "all" = "results",
) {
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id)
     SELECT t.id,$2,$3,$4,g.id FROM tasks t JOIN groups g ON g.id=t.group_id
     WHERE t.id=$1 AND g.left_at IS NULL AND COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true) AND (g.reply_mode='all' OR (g.reply_mode='results' AND $5='results'))
     ON CONFLICT DO NOTHING`,
    [taskId, `group_${kind}`, `group:${key}`, text, level],
  );
}

/** LINE 單則文字上限 5000 字；群組訊息保留餘裕。 */
export function groupText(text: string, max = 4500) {
  const t = text.trim();
  return t.length <= max
    ? t
    : `${t.slice(0, max - 20).trimEnd()}…（內容較長，已截斷）`;
}

export const commandAck =
  "收到，我會把這則需求整理好交給管理者確認，處理完會在這裡回報。";
export const followupAck = "收到，我接著上一題處理。";
export const disabledAck =
  "這個群組目前沒有啟用，這則需求不會被處理。請管理者到看板的群組頁啟用。";

/** 等待原因：每日執行次數用完、Codex 額度用完、系統暫停。 */
export type WaitReason = "daily" | "quota" | "paused";
const waitText: Record<WaitReason, string> = {
  daily:
    "今天的執行次數用完了，這件事已經保留，明天凌晨會自動繼續處理，不用重新提出。",
  quota:
    "Codex 額度暫時用完了，這件事已經保留，額度恢復後會自動繼續處理，不用重新提出。",
  paused:
    "系統目前暫停中，這件事已經保留，恢復後會自動繼續處理，不用重新提出。",
};
/** 工作被保留時告訴群組一聲，不要讓人以為機器人沒反應；同一群組每 6 小時最多一則。 */
export async function tellGroupWaiting(
  c: Queryable,
  taskId: string,
  reason: WaitReason,
) {
  const bucket = Math.floor(Date.now() / (6 * 3600 * 1000));
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id)
     SELECT t.id,'group_waiting','group:waiting:'||g.id||':'||$3::text,$2,g.id FROM tasks t JOIN groups g ON g.id=t.group_id
     WHERE t.id=$1 AND g.left_at IS NULL AND ${groupRepliesOn} AND g.reply_mode IN ('results','all')
     ON CONFLICT DO NOTHING`,
    [taskId, waitText[reason], String(bucket)],
  );
}

/** 回覆「詳細」時要用的字：完整內容、全文等。 */
export const detailRequest =
  /^\s*(?:詳細|詳細內容|全文|看全文|完整|完整內容|完整報告)\s*[。.!！]?\s*$/;
export const detailHint = "想看完整內容，「回覆」這則訊息打「詳細」。";

/** 完整回答轉成 LINE 訊息：去掉圖片語法、依段落切成最多 5 則，每則 4,500 字內。 */
export function lineChunks(answer: string, max = 5, size = 4500) {
  const text = answer
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chunks: string[] = [];
  let current = "";
  for (const part of text.split(/\n\n/)) {
    const piece = part.length > size ? part.slice(0, size) : part;
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  if (chunks.length <= max) return chunks;
  const kept = chunks.slice(0, max);
  kept[max - 1] = groupText(
    `${kept[max - 1]}\n\n…（內容太長，後面省略；完整報告請管理者在看板查看）`,
    size,
  );
  return kept;
}
