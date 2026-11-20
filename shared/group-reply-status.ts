import type { Group, Settings } from "./types.js";
import { quotaBlocked } from "./line-quota.js";

/** 依已儲存的總開關、群組設定與推播狀態顯示結果。即時回覆不使用推播額度。 */
export function groupReplyStatus(
  group: Pick<Group, "reply_mode" | "left_at">,
  settings: Pick<Settings, "group_replies">,
  health: { name: string; ok: boolean }[] | undefined,
  now = new Date(),
) {
  if (group.left_at)
    return { replies: false, text: "不會回覆，機器人已離開群組" };
  if (settings.group_replies === false)
    return { replies: false, text: "不會回覆，設定頁的總開關已關閉" };
  if (group.reply_mode === "off")
    return { replies: false, text: "不會回覆，這個群組設為不回覆" };
  if (quotaBlocked(health)) {
    const month = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        month: "numeric",
      }).format(now),
    );
    return {
      replies: true,
      text: `只會即時回覆「收到」等訊息，本月推播額度已用完，預計 ${(month % 12) + 1}/1 重置，你可打 /進度 補看`,
    };
  }
  return {
    replies: true,
    text:
      group.reply_mode === "all"
        ? "會回覆「收到」、需求整理進度與結果"
        : "會回覆「收到」與結果",
  };
}
