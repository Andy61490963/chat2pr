import type { TaskStatus } from "./types.js";

export type TriggerMode = "command" | "auto";
export const isTaskCommand = (text: string | null | undefined) =>
  /^\/任務(?:\s|[:：]|$)/u.test(text ?? "");
/**
 * 「/進度」：用 reply token 取回本群組的需求狀態與先前沒送到的回覆。
 * 和 /任務 一樣必須在開頭，後接空白、冒號或直接結束；「/進度表」「有人說 /進度」不算。
 */
export const isProgressCommand = (text: string | null | undefined) =>
  /^\/進度(?:\s|[:：]|$)/u.test(text ?? "");

export interface ChatMessage {
  id: string;
  sender: string | null;
  type: string;
  text: string | null;
  received_at: string;
  quoted_id: string | null;
  // 被引用訊息的內容摘要與發言者；對方已撤回、到期或早於機器人加入時為空值。
  quoted_text: string | null;
  quoted_sender: string | null;
  revoked: boolean;
  expired: boolean;
  has_image: boolean;
  image_state: "ready" | "pending" | "failed" | null;
  routing: "chat" | "pending" | "processed";
  tasks: { id: string; title: string; status: TaskStatus }[];
}
export interface ChatPage {
  messages: ChatMessage[];
  next: string | null;
}
