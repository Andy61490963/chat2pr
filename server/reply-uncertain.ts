import { claimingNote } from "../shared/group-delivery.js";

/** 管理者提醒跟著原通知解除；正在用免費回覆取回時，等 LINE 回應後再判定。 */
export const groupReplyStillUncertain = `EXISTS (SELECT 1 FROM notifications source
  WHERE 'reply_uncertain:'||source.id=n.dedupe_key AND source.line_reply_policy='manual'
    AND (source.sent_at IS NULL OR source.last_error='${claimingNote}'))`;
