import type { SourceMessage, TaskStatus } from "./types.js";
import type { BotMessage } from "./group-delivery.js";

export type TriggerMode = "command" | "auto";
export const isTaskCommand = (text: string | null | undefined) =>
  /^\/任務(?:\s|[:：]|$)/u.test(text ?? "");
/**
 * 「/進度」：用 reply token 取回本群組的需求狀態與先前沒送到的回覆。
 * 和 /任務 一樣必須在開頭，後接空白、冒號或直接結束；「/進度表」「有人說 /進度」不算。
 */
export const isProgressCommand = (text: string | null | undefined) =>
  /^\/進度(?:\s|[:：]|$)/u.test(text ?? "");

export interface ChatMessage extends SourceMessage {
  quoted_id: string | null;
  // 被引用訊息的內容摘要與發言者；對方已撤回、到期或早於機器人加入時為空值。
  // 引用的是機器人送到群組的訊息時，發言者固定為「機器人」。
  quoted_text: string | null;
  quoted_sender: string | null;
  /** 引用的是機器人訊息時，該則在 bot_messages 的 id（通知編號，不是 LINE 訊息 ID），用來跳到那一則。 */
  quoted_bot_id: string | null;
  expired: boolean;
  image_state: "ready" | "pending" | "failed" | null;
  routing: "chat" | "pending" | "processed";
  tasks: { id: string; title: string; status: TaskStatus }[];
}
export interface ChatPage {
  messages: ChatMessage[];
  /**
   * 與本頁成員訊息同一時間範圍內，機器人送到本群組的訊息（由舊到新）。
   * 範圍：本頁最舊一則之後（最後一頁不設下限）、上一頁最舊一則之前（第一頁不設上限），跨頁不重複也不遺漏。
   */
  bot_messages: BotMessage[];
  next: string | null;
}
