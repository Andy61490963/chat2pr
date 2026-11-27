import { splitQueryAnswer } from "../shared/query-answer.js";
import type { QuotaHoldKind } from "../shared/subscription-quota.js";
import { quotaShortPrefix } from "../shared/line-quota.js";
/**
 * 回覆提出需求的群組。管理者私訊之外，群組成員也要知道需求收到了、結果是什麼。
 *
 * 群組推播會依群組人數計入 LINE 的推播額度，所以每個群組可以選：
 * - off：不回覆群組。
 * - results：只回覆結果（查詢答案、無需修改、PR 完成、合併、取消、需要人工處理）。預設。
 * - all：另外在需求整理完成、等待確認時通知。
 * 「/任務」訊息的立即回覆使用 reply token，不計入推播額度，off 以外都會回。
 */
import type { DbClient } from "./db.js";
import type { ChatButton as QuickReply } from "./chat-platform.js";
import { redact } from "./policy.js";
import { importantLineGroupNotice, staleNotification } from "./line-quota.js";
import type { TaskStatus } from "../shared/types.js";

export type ReplyMode = "off" | "results" | "all";
/** 設定頁的總開關（settings.group_replies），沒設定過視為開啟。 */
export const groupRepliesOn =
  "COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true)";
export const replyModes: ReplyMode[] = ["off", "results", "all"];

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * 依任務所屬群組的回覆設定排入群組通知；群組已離開或設定不需要時不排。
 * quickReplies：附在訊息下方的 LINE 快速回覆按鈕（目前只有補問的常見答案）。
 */
export async function notifyGroup(
  c: Queryable,
  taskId: string,
  kind: string,
  key: string,
  text: string,
  level: "results" | "all" = "results",
  quickReplies: QuickReply[] = [],
) {
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,quick_replies)
     SELECT t.id,$2,$3,$4,g.id,$6::jsonb FROM tasks t JOIN groups g ON g.id=t.group_id
     WHERE t.id=$1 AND g.left_at IS NULL AND COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true) AND (g.reply_mode='all' OR (g.reply_mode='results' AND $5='results'))
     ON CONFLICT DO NOTHING`,
    [
      taskId,
      `group_${kind}`,
      `group:${key}`,
      text,
      level,
      quickReplies.length ? JSON.stringify(quickReplies) : null,
    ],
  );
}

/**
 * 不經由任務所屬群組、直接指定群組排入通知（例如判讀沒有建立任務時的說明）。
 * 條件與 notifyGroup 的「只回覆結果」相同：群組未離開、總開關開啟、reply_mode 為 results 或 all。
 */
export async function notifyGroupDirect(
  c: Queryable,
  groupId: string,
  taskId: string | null,
  kind: string,
  key: string,
  text: string,
  sourceMessageId?: string,
) {
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,source_message_id,discord_thread_id)
     SELECT $2,$3,$4,$5,g.id,$6,m.discord_thread_id FROM groups g
     LEFT JOIN messages m ON m.id=$6 AND m.group_id=g.id
     WHERE g.id=$1 AND g.left_at IS NULL AND ${groupRepliesOn} AND g.reply_mode IN ('results','all')
     ON CONFLICT DO NOTHING`,
    [groupId, taskId, `group_${kind}`, `group:${key}`, groupText(text), sourceMessageId ?? null],
  );
}

/** 判讀沒有建立新任務時，回給用 /任務 提出的群組的說明。 */
export const triageDuplicateText = (title: string) =>
  `這則和「${title}」是同一件事，已記在那題，處理完會一起回報，不用重新提出。`;
/** 記住的內容回到群組前先遮罩憑證格式，並以字元（非 UTF-16 單位）截到 100 字，避免切壞表情符號。 */
export const triageRememberedText = (content: string) =>
  `已記住：${Array.from(redact(content)).slice(0, 100).join("")}`;
export const triageKnownMemoryText = "這條已經記住了。";
export const triageIgnoredText =
  "這則沒有看到要處理的事項，請在 /任務 後寫清楚要查或要改什麼。";

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
/** 本群組的需求判讀連續失敗而停止（groups.triage_failures>=3，見 triage.ts、triage-window.ts）。 */
export const triageStoppedAck =
  "收到，但這個群組的需求判讀目前因連續錯誤暫停，訊息已保留；管理者排除問題後會接著整理，不用重新提出。";
/** 點了補問的常見答案按鈕，但那一題已回答、需求已改版或按鈕不屬於這個群組。 */
export const staleAnswerAck = "這題已經回答過或需求已更新，請看最新的提問。";
/** 用「回覆」回答補問、內容卻含憑證格式：不收、不交給 AI，也不能回「收到」讓人以為已收下。 */
export const credentialAnswerAck =
  "這則回答看起來含有密碼或金鑰，沒有收下，也不會交給 AI。請先收回這則訊息，機密改由管理者在看板輸入；其他內容請不含機密再回覆一次。";
export interface AckState {
  /** 原本要回的 commandAck 或 followupAck（可能已附上預估時間）。 */
  base: string;
  /** 系統暫停或暫停新需求判讀。 */
  paused: boolean;
  /** 本群組的需求判讀因連續失敗停止（triage_failures>=3），要等管理者按「重新辨識」。 */
  triageStopped: boolean;
  /** 群組沒有已啟用且已驗證的綁定專案（與 triage-window.ts 的條件相同）。 */
  noProject: boolean;
  /** 訂閱模式且 Codex 額度關卡關閉。 */
  quotaKind: QuotaHoldKind | null;
}
/** 依優先序挑「收到」的文字：暫停 → 判讀停止 → 沒有可用專案 → AI 額度 → 原文字。 */
export function ackFor(s: AckState) {
  if (s.paused) return pausedAck;
  if (s.triageStopped) return triageStoppedAck;
  if (s.noProject) return noProjectAck;
  if (!s.quotaKind) return s.base;
  return quotaWaitReason(s.quotaKind) === "quota"
    ? aiQuotaAck
    : "收到，系統暫時無法確認 AI 額度，這則已保留，確認可用後會自動處理，不用重新提出。";
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
  // Discord 的「群組」是頻道；用使用者看到的詞。
  place: "群組" | "頻道" | "討論串" = "群組",
  hasUnconfirmedReply = false,
) {
  const lines = tasks.map(
    (t) =>
      `- ${t.title}：${t.asking ? "等你們回答一個問題" : groupStatus[t.status]}`,
  );
  if (total > tasks.length) lines.push(`…另外還有 ${total - tasks.length} 件`);
  const head = tasks.length
    ? `這個${place}最近的需求（還沒結束或 7 天內有變動）：\n${lines.join("\n")}`
    : `這個${place}最近 7 天沒有需求。`;
  if (hasUnconfirmedReply) return groupText(`${head}\n\n下面是這次取回的回覆，包含先前送達狀態未確認的訊息。`);
  return groupText(`${head}\n\n${pending ? "下面是先前沒送到的回覆。" : "目前沒有待取回的結果。"}`);
}
export const progressMoreNote = (n: number) => `還有 ${n} 則，再輸入 /進度。`;

/** 群組回覆的 LINE 快速回覆按鈕（notifications.quick_replies）。 */
export type { QuickReply };
export interface ClaimedReply {
  id: string;
  text: string;
  quick_replies: QuickReply[] | null;
}
/** 佔住要補送的通知時寫的說明；送出後清掉，失敗時記下原因。 */
export const claimingNote = "以 /進度 回覆補送中";
export const replyFailedNote = "以 /進度 回覆補送失敗，下次再試";
export const supersededNote = "已有較新的回覆，未補送";
/** 同一則通知以 /進度 補送、被 LINE 以內容問題拒收的次數上限；到了就不再取回，避免整個群組的 /進度 一直失敗。 */
export const REPLY_FAILURE_LIMIT = 2;
export const replyGaveUpNote =
  "以 /進度 補送多次失敗，已停止補送，請管理者在看板查看並手動轉達";
/** 尚未開始送出且超過這段時間的領取可被回收；正在傳送的通知另以列鎖保護到寫回。 */
export const claimTimeout = "2 minutes";
export interface GroupReplyClaim {
  ids: string[];
  /** 保留 PostgreSQL 的微秒精度，用來核對目前仍是同一輪領取。 */
  claimedAt: string;
  retryIds?: string[];
}

/** 核對領取時間，並鎖住此次仍持有的通知直到寫回結果。 */
export async function lockGroupReplyClaim(c: DbClient, claim: GroupReplyClaim) {
  const { rows } = await c.query<{ id: string; valid: boolean }>(
    `SELECT id,sent_at>=clock_timestamp()-$4::interval AS valid FROM notifications
     WHERE id=ANY($1::uuid[]) AND sent_at=$2::timestamptz AND last_error=$3 AND sent_message_id IS NULL
     FOR UPDATE SKIP LOCKED`,
    [claim.ids, claim.claimedAt, claimingNote, claimTimeout],
  );
  return rows;
}

/**
 * reply 失敗是不是這批內容的問題（要計入 reply_failures）：只算 LINE 明確拒收的 4xx。
 * 不算的：429 限流、401／403 權杖或權限、400 但訊息在說 reply token（逾時或已用過，換個 token 就好）、
 * 5xx、逾時、沒有權杖（status 為 null）——這些都不是補送內容造成的，下次 /進度 換新的 token 可以再試。
 */
export function replyRejected(status: number | null, message?: unknown) {
  if (status === null || status < 400 || status >= 500) return false;
  if ([401, 403, 429].includes(status)) return false;
  return !(typeof message === "string" && /reply ?token/i.test(message));
}

/**
 * 收回 /進度 佔住後沒有寫回結果的通知（程序在收訊交易提交後、reply 結果寫回前中止）：
 * 放回未送出、改寫成 replyFailedNote，下一次 /進度 或推播可以再取。正在處理的列（被鎖住）略過。
 */
export async function reclaimStaleClaims(c: Queryable) {
  await c.query(
    `UPDATE notifications u SET sent_at=NULL,last_error=$2
     FROM (SELECT n.id FROM notifications n JOIN groups g ON g.id=n.group_id
       WHERE g.platform IN ('line','discord') AND n.last_error=$1
       AND n.sent_message_id IS NULL AND n.sent_at<now()-$3::interval
       FOR UPDATE OF n SKIP LOCKED) s
     WHERE u.id=s.id`,
    [claimingNote, replyFailedNote, claimTimeout],
  );
}

/**
 * 可以用 /進度 取回的群組通知（$1 是群組，需先 JOIN tasks t）：
 * - 本群組、未送出、7 天內；不看 attempts，推播失敗被放棄的正是要取回的。
 * - 排除很快就過時的 group_waiting；補問只取任務仍在等這一版回答的（與 answers.ts questionByQuote 相同）；
 *   group_received 只在仍待確認、group_failed 只在仍是失敗、group_resumed（自動接續）只在這個版本的接續還沒結束時才送。
 * - LINE 的指令判讀說明由 pendingFrom 另外取回。「和某題是同一件事」掛在被重複的那題上，
 *   若算進「每個任務只取最新一則」，會把那題還在等回答的補問標成已被取代。
 * - 排除以 /進度 補送已被 LINE 拒收 REPLY_FAILURE_LIMIT 次的：reply token 一次只能用一次、整批一起成敗，
 *   一直取回同一則會讓這個群組的 /進度 永遠失敗。
 */
const retrievable = (n: string, group: string, inFlight: string) =>
  `${n}.group_id=${group} AND t.group_id=${group}
   AND (${n}.sent_at IS NULL${inFlight})
   AND ${n}.created_at>now()-interval '7 days' AND ${n}.kind NOT IN ('group_waiting','group_triage')
   AND ${n}.reply_failures<${REPLY_FAILURE_LIMIT}
   AND (${n}.kind<>'group_question' OR (t.status='awaiting_approval' AND t.question IS NOT NULL AND ${n}.dedupe_key='group:question:'||t.id||':'||t.version))
   AND (${n}.kind<>'group_received' OR t.status='awaiting_approval')
   AND (${n}.kind<>'group_failed' OR t.status='failed')
   AND (${n}.kind<>'group_resumed' OR (t.status IN ('queued','running','reviewing','budget_wait') AND ${n}.dedupe_key='group:resumed:'||t.id||':'||t.version))
   AND (${n}.kind<>'group_no_changes' OR (t.status='answered' AND ${n}.dedupe_key='group:no_changes:'||t.id||':'||t.version))`;
/**
 * 每個任務只取最新一則：同一任務有較新、也可取回的通知時，舊的不送。
 * group_received 排最後：它和補問常在同一個交易排入（approvalNotice 後接 askInGroup），created_at 相同，
 * 只比時間與 id 會隨機挑到「收到」而把補問標成已被取代，群組就再也拿不到要回答的問題。
 */
const newer = (a: string, b: string) =>
  `(${a}.kind<>'group_received',${a}.created_at,${a}.id)>(${b}.kind<>'group_received',${b}.created_at,${b}.id)`;
// Discord 補送期間群組仍可執行 /進度，已佔住的新通知仍要擋住同任務的舊通知。
export function pendingGroupRepliesFrom(automatic: boolean, forAlert = false) {
  const group = forAlert ? "g.id" : "$1";
  const platform = forAlert ? "'line'" : "$2";
  const thread = forAlert ? "NULL::text" : "$4::text";
  const claimed = forAlert ? ` OR (n.last_error='${claimingNote}' AND n.sent_message_id IS NULL)` : "";
  const newerClaim = forAlert ? "" : " OR ($2='discord' AND m.last_error=$3 AND m.sent_message_id IS NULL)";
  const newestOfTask = `NOT EXISTS(SELECT 1 FROM notifications m WHERE m.task_id=n.task_id AND ${retrievable("m", group, newerClaim)} AND ${newer("m", "n")})`;
  return `FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id JOIN groups g ON g.id=n.group_id
  WHERE g.platform=${platform} AND (g.platform<>'line' OR n.line_digest_id IS NULL
    OR n.last_error LIKE '${quotaShortPrefix}%'
    OR (n.line_reply_policy IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notifications p WHERE p.line_digest_id=n.line_digest_id AND p.sent_at IS NULL
        AND p.attempts<3 AND p.line_reply_policy IS NULL AND COALESCE(p.last_error,'') NOT LIKE '${quotaShortPrefix}%')))
  AND (n.line_reply_policy IS DISTINCT FROM 'free' OR NOT (${staleNotification}))
  AND ((${retrievable("n", group, claimed)} AND ${newestOfTask}) OR (
    g.platform='line' AND n.group_id=${group} AND (n.sent_at IS NULL${claimed}) AND n.reply_failures<${REPLY_FAILURE_LIMIT}
    AND (n.task_id IS NULL OR t.group_id=${group}) AND NOT (${staleNotification})
    AND (n.kind IN ('group_check','group_triage') OR (n.kind='group_waiting'
      AND ${automatic ? "true" : "n.line_reply_policy IS NOT NULL"}))))
  AND (g.platform<>'discord' OR (n.kind<>'group_received' AND
    (n.discord_retry_at IS NULL OR n.discord_retry_at<=now()) AND
    (CASE WHEN n.source_message_id IS NOT NULL THEN n.discord_thread_id ELSE t.discord_thread_id END)
      IS NOT DISTINCT FROM ${thread}))`;
}

/**
 * 在呼叫端的交易內佔住最舊的 limit 則可取回通知：先以目前的陳述式時間設定 sent_at，
 * flushNotifications 與另一個 /進度 都用 SKIP LOCKED，不會重複送。
 * 同一任務較舊的未送通知會標成已被取代，LINE 在領取時標記，Discord 在送達後標記。
 * 送出後由呼叫端寫回 sent_message_id；送不出去時把 sent_at 還原。
 * 程序在兩者之間中止時，佔住的列會停在 claimingNote，由 reclaimStaleClaims（每輪通知排程）在 2 分鐘後放回。
 */
export async function claimPendingGroupReplies(
  c: DbClient,
  groupId: string,
  limit: number,
  platform: "line" | "discord" = "line",
  threadId: string | null = null,
  automatic?: "important" | "all",
  freshEvent = true,
) {
  const candidates = (
    await c.query<ClaimedReply & { kind: string; unconfirmed: boolean; important: boolean; retryable: boolean }>(
      `SELECT n.id,n.kind,n.text,n.quick_replies,n.line_reply_policy IS NOT DISTINCT FROM 'manual' AS unconfirmed,
         ${importantLineGroupNotice} AS important,
         (n.line_reply_retry_count=0 AND
           n.line_reply_uncertain_at <= $5::timestamptz - interval '5 minutes') AS retryable
       ${pendingGroupRepliesFrom(!!automatic)}
       ${automatic ? `AND g.enabled AND g.left_at IS NULL AND g.reply_mode<>'off' AND ${groupRepliesOn}` : ""}
       ${automatic === "important" ? `AND (${importantLineGroupNotice} OR n.line_reply_policy='free')` : ""}
       ORDER BY ${automatic ? `(${importantLineGroupNotice}) DESC,` : ""} n.created_at,n.id FOR UPDATE OF n SKIP LOCKED`,
      [groupId, platform, claimingNote, threadId, new Date(Date.now())],
    )
  ).rows;
  const rows = automatic
    ? candidates.filter((r) => !r.unconfirmed || (freshEvent && r.important && r.retryable))
    : candidates;
  // LINE 只顯示最後一則訊息的快速回覆。其他補問先摘要，下一次發言仍能收到可直接作答的原訊息。
  const question = automatic && rows.find((r) => r.quick_replies?.length);
  const picked = rows.filter((r) => !question || !r.quick_replies?.length || r === question).slice(0, limit);
  if (question) picked.sort((a, b) => Number(a === question) - Number(b === question));
  const pickedIds = new Set(picked.map((r) => r.id));
  let claim: GroupReplyClaim | undefined;
  if (picked.length) {
    const ids = picked.map((r) => r.id);
    const stamped = await c.query<{ claimed_at: string }>(
      `UPDATE notifications SET sent_at=statement_timestamp(),last_error=$2,
         line_reply_retry_count=line_reply_retry_count + CASE WHEN $3 AND line_reply_policy='manual' THEN 1 ELSE 0 END
       WHERE id=ANY($1::uuid[]) RETURNING sent_at::text AS claimed_at`,
      [ids, claimingNote, !!automatic],
    );
    claim = { ids, claimedAt: stamped.rows[0].claimed_at, retryIds: automatic ? picked.filter((r) => r.unconfirmed).map((r) => r.id) : [] };
    if (platform === "line") await supersedeOlderGroupReplies(c, groupId, ids);
  }
  return {
    replies: picked.map((r) =>
      r.kind === "group_answered"
        ? { ...r, text: splitQueryAnswer(r.text).body }
        : r,
    ),
    uncertain: candidates.filter((r) => r.unconfirmed && r.important && !pickedIds.has(r.id)).length,
    remaining: rows.length - picked.length,
    summaries: automatic ? rows.filter((r) => !pickedIds.has(r.id)).slice(0, 20).map((r) => {
      const text = r.kind === "group_answered" ? splitQueryAnswer(r.text).body : r.text;
      return `- ${Array.from(redact(text).replace(/\s+/g, " ")).slice(0, 100).join("")}`;
    }) : [],
    claim,
  };
}

/** 依資料庫的時間精度略過已被取代的回覆。Discord 的收到反應仍由通知排程處理。 */
export async function supersedeOlderGroupReplies(
  c: DbClient,
  groupId: string,
  ids: string[],
  platform: "line" | "discord" = "line",
) {
  await c.query(
    `UPDATE notifications u SET sent_at=now(),last_error=$3
       FROM (SELECT o.id FROM notifications o JOIN notifications p ON p.task_id=o.task_id AND p.id=ANY($2::uuid[])
         WHERE o.group_id=$1 AND o.sent_at IS NULL AND o.kind<>'group_waiting' AND o.id<>p.id AND o.created_at<=p.created_at
         AND p.kind NOT IN ('group_waiting','group_triage','group_check')
         AND ($4='line' OR o.kind<>'group_received')
         AND ($4<>'line' OR o.line_digest_id IS NULL)
         FOR UPDATE OF o SKIP LOCKED) s
       WHERE u.id=s.id`,
    [groupId, ids, supersededNote, platform],
  );
}

/** 本群組還沒結束或 7 天內有變動的任務，只讀 group_id 等於本群組的資料。 */
export async function progressTasks(
  c: DbClient,
  groupId: string,
  limit = 8,
  threadId: string | null = null,
) {
  const rows = (
    await c.query<ProgressTask & { total: string }>(
      `SELECT CASE WHEN $3::text IS NULL AND r.thread_id IS NOT NULL THEN t.title||' <#'||substr(r.thread_id,9)||'>' ELSE t.title END AS title,t.status,(t.status='awaiting_approval' AND t.question IS NOT NULL) AS asking,count(*) OVER() AS total
       FROM tasks t LEFT JOIN discord_request_threads r ON r.group_id=t.group_id AND r.thread_id=t.discord_thread_id WHERE t.group_id=$1 AND (t.discord_thread_id IS NOT DISTINCT FROM $3::text OR ($3::text IS NULL AND r.thread_id IS NOT NULL))
       AND (t.status NOT IN ('merged','answered','closed','rejected','cancelled') OR t.updated_at>now()-interval '7 days')
       ORDER BY t.updated_at DESC,t.id LIMIT $2`,
      [groupId, limit, threadId],
    )
  ).rows;
  return {
    tasks: rows.map(({ title, status, asking }) => ({ title, status, asking })),
    total: Number(rows[0]?.total ?? 0),
  };
}

/** 等待原因：每日執行次數用完、Codex 額度用完、系統暫停、執行位置已滿（排隊）。 */
export function quotaWaitReason(kind: QuotaHoldKind) {
  return kind === "exhausted" || kind === "reserve" ? "quota" : "quota_unconfirmed";
}
export type WaitReason = "daily" | ReturnType<typeof quotaWaitReason> | "paused" | "busy";
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
    "chat2pr 暫時沒有可用的 AI 額度，這件事已經保留，額度恢復後會自動繼續處理，不用重新提出。",
  quota_unconfirmed:
    "系統暫時無法確認 AI 額度，這件事已經保留，確認可用後會自動繼續處理，不用重新提出。",
  paused:
    "系統目前暫停中，這件事已經保留，恢復後會自動繼續處理，不用重新提出。",
};
/** 逾時但修改已保留、系統自動接續一次時告訴群組的進度；不是失敗訊息（#256）。 */
export const autoResumeText = (next: "verify" | "repair") =>
  next === "repair"
    ? "這題比較大，單次執行的時間用完了。已保留目前的修改與審查意見，系統會自動接續修復，不用重新提出。"
    : "這題比較大，單次執行的時間用完了。已保留目前的修改，系統會自動接續測試與審查，不用重新提出。";
/** 工作被保留時告訴成員一聲，同一群組或討論串每 6 小時最多一則。 */
// 派工提醒查詢與寫入使用同一個目的地與六小時時段。
export const waitNotificationKey = "'group:waiting:'||COALESCE(t.discord_thread_id,t.group_id)||':'||$1::text";
export const waitNotificationBucket = () => String(Math.floor(Date.now() / (6 * 3600 * 1000)));

export async function tellGroupWaiting(
  c: Queryable,
  taskId: string,
  reason: WaitReason,
  place?: QueuePlace,
) {
  const text =
    reason === "busy" && place ? queuedText(place) : waitText[reason];
  await c.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id)
     SELECT t.id,'group_waiting',${waitNotificationKey},$2,g.id FROM tasks t JOIN groups g ON g.id=t.group_id
     WHERE t.id=$3 AND g.left_at IS NULL AND ${groupRepliesOn} AND g.reply_mode IN ('results','all')
     ON CONFLICT DO NOTHING`,
    [waitNotificationBucket(), text, taskId],
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
