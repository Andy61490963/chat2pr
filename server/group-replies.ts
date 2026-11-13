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
export const disabledAck =
  "這個群組目前沒有啟用，這則需求不會被處理。請管理者到看板的群組頁啟用。";
