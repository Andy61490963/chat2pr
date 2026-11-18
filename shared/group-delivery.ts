/**
 * 群組訊息（notifications.group_id 有值的那幾列）送到 LINE 群組了沒有。
 * 聊天室與任務詳情共用：伺服器用 deliveryState 把 sent_at、attempts、last_error 整理成固定的狀態與白話原因，
 * 瀏覽器只拿到整理後的結果，看不到原始 last_error 與 LINE 的訊息 ID。
 *
 * last_error 的固定文字由這些地方寫入，改字時要同步這裡的對照（見 docs/conventions.md 第 3 節）：
 * - server/line.ts 的 flushNotifications：額度用完（quotaExhaustedDetail）、限流、群組回覆總開關關閉、其他狀態碼。
 * - server/group-replies.ts：以 /進度 補送中、補送失敗、已有較新的回覆。
 * - server/line-quota.ts 的 expireStaleNotifications：已過期，未補送（expiredNote）。
 */
import { expiredNote, quotaExhaustedDetail } from "./line-quota.js";

/** 與 server/group-replies.ts 的同名常數相同；tests/group-delivery.test.ts 會核對。 */
export const claimingNote = "以 /進度 回覆補送中";
export const replyFailedNote = "以 /進度 回覆補送失敗，下次再試";
export const supersededNote = "已有較新的回覆，未補送";
/** server/line.ts flushNotifications 在總開關關閉時寫入的字。 */
export const repliesOffNote = "群組回覆已關閉，未送出";
/** server/line.ts 一般 429（短時間限流）錯誤訊息的開頭。 */
export const rateLimitedPrefix = "LINE 推播太頻繁";

/** 推播最多試幾次（server/line.ts 的 attempts<3）。 */
export const maxPushAttempts = 3;

export type DeliveryStatus =
  "sent" | "skipped" | "claiming" | "pending" | "failed";
export type DeliveryReason =
  | "quota"
  | "group_size"
  | "rate"
  | "replies_off"
  | "expired"
  | "superseded"
  | "reply_failed"
  | "error";
export interface Delivery {
  status: DeliveryStatus;
  /** 沒送出的原因分類；已送出或還沒試過時為 null。 */
  reason: DeliveryReason | null;
  /** 白話原因，不含原始錯誤。 */
  note: string;
}

export interface DeliveryRow {
  sent_at: string | Date | null;
  /** LINE 是否已回傳訊息 ID；只用來判斷，不回傳給瀏覽器。 */
  has_message_id?: boolean;
  attempts: number;
  last_error: string | null;
}

const reasonNotes: Record<DeliveryReason, string> = {
  quota: "LINE 本月推播額度已用完",
  group_size: "LINE 剩餘推播額度不夠這個群組的人數",
  rate: "LINE 暫時限制推播速度，稍後會再送",
  replies_off: repliesOffNote,
  expired: expiredNote,
  superseded: supersededNote,
  reply_failed: "以 /進度 補送沒有成功，下次再試",
  error: "LINE 沒有收下這則訊息",
};

/** 把 last_error 的固定文字對到原因；認不得的一律當成一般錯誤，只留狀態碼。 */
function reasonOf(error: string): { reason: DeliveryReason; note: string } {
  const pick = (reason: DeliveryReason, note = reasonNotes[reason]) => ({
    reason,
    note,
  });
  if (error === repliesOffNote) return pick("replies_off");
  if (error === expiredNote) return pick("expired");
  if (error === supersededNote) return pick("superseded");
  if (error.startsWith("以 /進度 回覆補送失敗")) return pick("reply_failed");
  if (error.startsWith(rateLimitedPrefix)) return pick("rate");
  if (/額度/.test(error) && /人數/.test(error)) return pick("group_size");
  if (error === quotaExhaustedDetail || /額度已用完/.test(error))
    return pick("quota");
  // 其他錯誤已經過 redact，但仍可能夾帶內部細節：只取狀態碼。
  const code = error.match(/（(\d{3})）/)?.[1];
  return pick("error", code ? `LINE 回應錯誤（${code}）` : reasonNotes.error);
}

/** 依 sent_at、attempts、last_error 推出送達狀態。 */
export function deliveryState(row: DeliveryRow): Delivery {
  const error = row.last_error?.trim() || null;
  if (error === claimingNote)
    // 補送成功會清掉 last_error；萬一寫回 ID 後還留著這句，仍算已送出。
    return row.has_message_id
      ? { status: "sent", reason: null, note: "已送到群組" }
      : { status: "claiming", reason: null, note: "正在以 /進度 回覆補送" };
  if (row.sent_at) {
    if (!error) return { status: "sent", reason: null, note: "已送到群組" };
    return { status: "skipped", ...reasonOf(error) };
  }
  if (!error)
    return row.attempts >= maxPushAttempts
      ? { status: "failed", reason: "error", note: reasonNotes.error }
      : { status: "pending", reason: null, note: "排隊等待送出" };
  const r = reasonOf(error);
  if (r.reason === "reply_failed" && /多次/.test(error))
    return {
      status: "failed",
      reason: r.reason,
      note: "以 /進度 補送多次失敗",
    };
  return row.attempts >= maxPushAttempts
    ? { status: "failed", ...r }
    : { status: "pending", ...r };
}

/** 是否該提醒管理者：還沒送到、可能要代為轉達。略過（skipped）不算。 */
export const undelivered = (d: Delivery) =>
  d.status === "pending" || d.status === "failed" || d.status === "claiming";

/** 聊天室訊息旁的短標籤。 */
export function deliveryLabel(d: Delivery) {
  switch (d.status) {
    case "sent":
      return "已送出";
    case "skipped":
      return "未送出";
    case "claiming":
      return "補送中";
    case "pending":
      return d.reason === "quota" || d.reason === "group_size"
        ? "額度不足，未送出"
        : "等待送出";
    case "failed":
      return "送不出去";
  }
}

/** 任務詳情的提示句。 */
export function deliveryNotice(d: Delivery) {
  if (d.reason === "quota" || d.reason === "group_size")
    return `這則群組訊息沒有送出：${d.note}`;
  switch (d.status) {
    case "sent":
      return "已送到群組";
    case "skipped":
      return `沒有送到群組：${d.note}`;
    case "claiming":
      return "正在送到群組（成員打 /進度，正在用回覆補送）";
    case "pending":
      return d.reason ? `正在送到群組：${d.note}` : "正在送到群組";
    case "failed":
      return d.reason === "reply_failed"
        ? `這則群組訊息沒有送出：${d.note}`
        : `重試 ${maxPushAttempts} 次仍沒送出（${d.note}）`;
  }
}

/** 群組通知種類的名稱（聊天室標示機器人說的是什麼）。 */
export const groupKindLabels: Record<string, string> = {
  group_answered: "查詢回答",
  group_question: "補問",
  group_failed: "失敗說明",
  group_received: "收到需求",
  group_waiting: "等待說明",
  group_check: "定期檢查",
};

/** 任務詳情要提醒送達狀態的群組訊息種類。 */
export const drawerKinds = [
  "group_answered",
  "group_question",
  "group_failed",
] as const;

/** 聊天室裡的一則機器人群組訊息（不含 LINE 訊息 ID）。 */
export interface BotMessage {
  id: string;
  kind: string;
  task_id: string | null;
  task_title: string | null;
  created_at: string;
  /** 超過原文保留期限時為 null。 */
  text: string | null;
  delivery: Delivery;
}

/** 任務詳情的一則群組訊息。 */
export interface GroupDelivery {
  id: string;
  kind: string;
  created_at: string;
  text: string;
  delivery: Delivery;
}
