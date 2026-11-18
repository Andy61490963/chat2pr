/**
 * 回覆提出需求的群組。管理者私訊之外，群組成員也要知道需求收到了、結果是什麼。
 *
 * 群組推播會依群組人數計入 LINE 的推播額度，所以每個群組可以選：
 * - off：不回覆群組。
 * - results：只回覆結果（查詢答案、PR 完成、合併、取消、需要人工處理）。預設。
 * - all：另外在需求整理完成、等待確認時通知。
 * 「/任務」訊息的立即回覆使用 reply token，不計入推播額度，off 以外都會回。
 */
import type { DbClient } from "./db.js";
import type { TaskStatus } from "../shared/types.js";

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
export const answerAck = "收到你的回答，我接著處理。";
export const answerHeldAck = "收到你的回答，已交給管理者確認。";
export const disabledAck =
  "這個群組目前沒有啟用，這則需求不會被處理。請管理者到看板的群組頁啟用。";

/*
 * 「收到」要說實話：判讀前就會被擋下的狀態，訊息只是保留，不能承諾「處理完會在這裡回報」。
 * 只看收訊當下確定的狀態；每日次數、主機資源等要等管理者確認、開始執行後才會擋，那時另有 tellGroupWaiting。
 */
export const pausedAck =
  "收到，系統目前暫停處理新需求，這則已保留，恢復後會自動整理，不用重新提出。";
export const noProjectAck =
  "收到，需求已先記下。這個群組目前沒有可處理需求的專案，管理者把專案恢復可用後會自動接著處理，不用重新提出。";
export const aiQuotaAck =
  "收到，AI 額度暫時用完，這則已保留，額度恢復後會自動處理，不用重新提出。";
/** 用「回覆」回答補問、內容卻含憑證格式：不收、不交給 AI，也不能回「收到」讓人以為已收下。 */
export const credentialAnswerAck =
  "這則回答看起來含有密碼或金鑰，沒有收下，也不會交給 AI。請先收回這則訊息，機密改由管理者在看板輸入；其他內容請不含機密再回覆一次。";
export const undeliveredHint = (n: number) =>
  `有 ${n} 則先前沒送達的回覆，打 /進度 取回。`;

export interface AckState {
  /** 原本要回的 commandAck 或 followupAck（可能已附上預估時間）。 */
  base: string;
  /** 系統暫停或暫停新需求判讀。 */
  paused: boolean;
  /** 群組沒有已啟用且已驗證的綁定專案（與 triage-window.ts 的條件相同）。 */
  noProject: boolean;
  /** 訂閱模式且 Codex 額度關卡關閉。 */
  aiQuotaOut: boolean;
  /** 先前沒送達、可以用 /進度 取回的群組回覆數；0 表示不提。 */
  undelivered: number;
}
/** 依優先序挑「收到」的文字：暫停 → 沒有可用專案 → AI 額度 → 原文字。 */
export function ackFor(s: AckState) {
  const text = s.paused
    ? pausedAck
    : s.noProject
      ? noProjectAck
      : s.aiQuotaOut
        ? aiQuotaAck
        : s.base;
  return s.undelivered > 0
    ? `${text}\n${undeliveredHint(s.undelivered)}`
    : text;
}

/** 給群組成員看的任務狀態（成員沒有看板帳號，用白話說明下一步在誰手上）。 */
const groupStatus: Record<TaskStatus, string> = {
  awaiting_approval: "等管理者確認",
  queued: "排隊等待處理",
  running: "處理中",
  reviewing: "檢查結果中",
  budget_wait: "已保留，等額度恢復",
  ready: "已完成，等管理者合併",
  failed: "遇到問題，等管理者處理",
  merged: "已完成並合併",
  answered: "已回答",
  closed: "已結束",
  rejected: "管理者決定不處理",
  cancelled: "已取消",
};
export interface ProgressTask {
  title: string;
  status: TaskStatus;
  /** 任務在等群組回答問題。 */
  asking: boolean;
}
/** /進度 回覆的第一則：本群組的需求摘要。total 是符合條件的總件數（可能多於列出的）。 */
export function progressSummary(
  tasks: ProgressTask[],
  total: number,
  pending: number,
) {
  const lines = tasks.map(
    (t) =>
      `・${t.title}：${t.asking ? "等你們回答一個問題" : groupStatus[t.status]}`,
  );
  if (total > tasks.length) lines.push(`…另外還有 ${total - tasks.length} 件`);
  const head = tasks.length
    ? `這個群組最近的需求（還沒結束或 7 天內有變動）：\n${lines.join("\n")}`
    : "這個群組最近 7 天沒有需求。";
  return groupText(
    `${head}\n\n${pending ? "下面是先前沒送到的回覆。" : "目前沒有待取回的結果。"}`,
  );
}
export const progressMoreNote = (n: number) => `還有 ${n} 則，再輸入 /進度。`;

/** 群組回覆的 LINE 快速回覆按鈕（notifications.quick_replies）。 */
export interface QuickReply {
  label: string;
  data: string;
  displayText: string;
}
export interface ClaimedReply {
  id: string;
  text: string;
  quick_replies: QuickReply[] | null;
}
/** 佔住要用 reply token 補送的通知時寫的說明；送出後清掉，失敗時改寫成 replyFailedNote。 */
export const claimingNote = "以 /進度 回覆補送中";
export const replyFailedNote = "以 /進度 回覆補送失敗，下次再試";
export const supersededNote = "已有較新的回覆，未補送";

/**
 * 可以用 /進度 取回的群組通知（$1 是群組，需先 JOIN tasks t）：
 * - 本群組、未送出、7 天內；不看 attempts，推播失敗被放棄的正是要取回的。
 * - 排除很快就過時的 group_waiting；補問只取任務仍在等這一版回答的（與 answers.ts questionByQuote 相同）；
 *   group_received 只在仍待確認、group_failed 只在仍是失敗時才送。
 */
const retrievable = (n: string) =>
  `${n}.group_id=$1 AND t.group_id=$1 AND ${n}.sent_at IS NULL AND ${n}.created_at>now()-interval '7 days' AND ${n}.kind<>'group_waiting'
   AND (${n}.kind<>'group_question' OR (t.status='awaiting_approval' AND t.question IS NOT NULL AND ${n}.dedupe_key='group:question:'||t.id||':'||t.version))
   AND (${n}.kind<>'group_received' OR t.status='awaiting_approval')
   AND (${n}.kind<>'group_failed' OR t.status='failed')`;
/** 每個任務只取最新一則：同一任務有較新、也可取回的通知時，舊的不送。 */
const newestOfTask = `NOT EXISTS(SELECT 1 FROM notifications m WHERE m.task_id=n.task_id AND ${retrievable("m")} AND (m.created_at,m.id)>(n.created_at,n.id))`;
const pendingFrom = `FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE ${retrievable("n")} AND ${newestOfTask}`;

/** 本群組可用 /進度 取回的通知數，以及其中是否有推播失敗過的。 */
export async function pendingGroupReplies(c: DbClient, groupId: string) {
  const r = (
    await c.query<{ count: string; failed: boolean | null }>(
      `SELECT count(*) AS count,bool_or(n.last_error IS NOT NULL) AS failed ${pendingFrom}`,
      [groupId],
    )
  ).rows[0];
  return { count: Number(r?.count ?? 0), failed: r?.failed === true };
}

/**
 * 在呼叫端的交易內佔住最舊的 limit 則可取回通知：先設 sent_at=now()，
 * flushNotifications 與另一個 /進度 都用 SKIP LOCKED，不會重複送。
 * 同一任務較舊的未送通知一併標成已被取代，下次不會再冒出來。
 * 送出後由呼叫端寫回 sent_message_id；送不出去時把 sent_at 還原。
 */
export async function claimPendingGroupReplies(
  c: DbClient,
  groupId: string,
  limit: number,
) {
  const rows = (
    await c.query<ClaimedReply & { task_id: string; created_at: Date }>(
      `SELECT n.id,n.task_id,n.text,n.quick_replies,n.created_at ${pendingFrom}
       ORDER BY n.created_at,n.id FOR UPDATE OF n SKIP LOCKED`,
      [groupId],
    )
  ).rows;
  const picked = rows.slice(0, limit);
  if (picked.length) {
    await c.query(
      "UPDATE notifications SET sent_at=now(),last_error=$2 WHERE id=ANY($1::uuid[])",
      [picked.map((r) => r.id), claimingNote],
    );
    await c.query(
      `UPDATE notifications u SET sent_at=now(),last_error=$4
       FROM (SELECT o.id FROM notifications o JOIN unnest($2::uuid[],$3::timestamptz[]) p(task_id,created_at) ON o.task_id=p.task_id
         WHERE o.group_id=$1 AND o.sent_at IS NULL AND o.kind<>'group_waiting' AND o.created_at<p.created_at
         FOR UPDATE OF o SKIP LOCKED) s
       WHERE u.id=s.id`,
      [
        groupId,
        picked.map((r) => r.task_id),
        picked.map((r) => r.created_at),
        supersededNote,
      ],
    );
  }
  return {
    replies: picked.map(({ id, text, quick_replies }) => ({
      id,
      text,
      quick_replies,
    })),
    remaining: rows.length - picked.length,
  };
}

/** 本群組還沒結束或 7 天內有變動的任務，只讀 group_id 等於本群組的資料。 */
export async function progressTasks(c: DbClient, groupId: string, limit = 8) {
  const rows = (
    await c.query<ProgressTask & { total: string }>(
      `SELECT t.title,t.status,(t.status='awaiting_approval' AND t.question IS NOT NULL) AS asking,count(*) OVER() AS total
       FROM tasks t WHERE t.group_id=$1
       AND (t.status NOT IN ('merged','answered','closed','rejected','cancelled') OR t.updated_at>now()-interval '7 days')
       ORDER BY t.updated_at DESC,t.id LIMIT $2`,
      [groupId, limit],
    )
  ).rows;
  return {
    tasks: rows.map(({ title, status, asking }) => ({ title, status, asking })),
    total: Number(rows[0]?.total ?? 0),
  };
}

/** 等待原因：每日執行次數用完、Codex 額度用完、系統暫停、執行位置已滿（排隊）。 */
export type WaitReason = "daily" | "quota" | "paused" | "busy";
/** 排隊時的位置與預估：沒有歷史耗時就不寫時間。 */
export interface QueuePlace {
  position: number;
  running: number;
  minutes: number | null;
}
export function queuedText(q: QueuePlace) {
  const when = q.minutes
    ? `，預估大約 ${q.minutes} 分鐘後開始`
    : "，輪到時會自動開始";
  return `目前有 ${q.running} 件工作在處理，這件事排在第 ${q.position} 位${when}，不用重新提出。`;
}
const waitText: Record<WaitReason, string> = {
  busy: "目前有其他工作在處理，這件事正在排隊，輪到時會自動開始，不用重新提出。",
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
  place?: QueuePlace,
) {
  const bucket = Math.floor(Date.now() / (6 * 3600 * 1000));
  const text =
    reason === "busy" && place ? queuedText(place) : waitText[reason];
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id)
     SELECT t.id,'group_waiting','group:waiting:'||g.id||':'||$3::text,$2,g.id FROM tasks t JOIN groups g ON g.id=t.group_id
     WHERE t.id=$1 AND g.left_at IS NULL AND ${groupRepliesOn} AND g.reply_mode IN ('results','all')
     ON CONFLICT DO NOTHING`,
    [taskId, text, String(bucket)],
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
