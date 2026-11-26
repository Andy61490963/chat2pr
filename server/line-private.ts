import { randomUUID } from "node:crypto";
import {
  linePrivateDefaults,
  linePrivateDigestMinutes,
  linePrivateQuotaHold,
  lineServiceOutageMinutes,
  type LinePrivateMode,
} from "../shared/line-private.js";
import { expiredNote, lineQuotaLow, quotaRemaining } from "../shared/line-quota.js";
import { config } from "./config.js";
import type { Database } from "./db.js";
import {
  fetchLineQuota,
  LineQuotaExhausted,
  lineQuotaUsage,
  markQuotaExhausted,
  recordLinePush,
  saveQuotaUsage,
} from "./line-quota.js";
import { LineChatPlatform } from "./line-platform.js";
import { redact } from "./policy.js";

export const privateActionKinds = [
  "connection_secrets_updated",
  "approval",
  "risk",
  "input_required",
  "project_input",
  "failed",
  "interrupted",
  "triage",
  "publish_race",
] as const;

export function privateDigestText(items: { text: string }[], url: string) {
  const lines = items.slice(0, 5).map(({ text }) => {
    const first = text.split(/\r?\n/, 1)[0].trim();
    return `• ${first.length > 240 ? first.slice(0, 239) + "…" : first}`;
  });
  if (items.length > lines.length)
    lines.push(`另有 ${items.length - lines.length} 件，請到看板查看`);
  // 不寫平台名稱：同一份摘要也會送到 Discord。
  return ["你的通知摘要", ...lines, "", `看板：${url}`].join("\n");
}

type DigestItem = { id: string; text: string; line_digest_id: string | null };

/** LINE 與 Discord 的管理者私訊共用：篩選範圍、過期不補送、合併成摘要（#158、#207）。 */
export async function prepareDigest(db: Database, mode: LinePrivateMode, lowQuota = false) {
  const allowedKinds = mode === "action"
    ? privateActionKinds
    : lowQuota ? [...privateActionKinds, "answered", "ready", "merged", "no_changes"] : null;
  return db.transaction(async (c) => {
    const now = new Date();
    // 服務異常比對同一次中斷，恢復後留在鈴鐺；全通知模式的恢復私訊也須符合 15 分鐘門檻。
    await c.query(
      `UPDATE notifications n SET sent_at=$5,
         last_error=CASE WHEN n.created_at<$5::timestamptz-interval '24 hours' THEN $1 ELSE '已留在看板鈴鐺' END
       WHERE n.group_id IS NULL AND n.sent_at IS NULL AND (
         n.created_at<$5::timestamptz-interval '24 hours'
         OR (NOT $2 AND NOT (n.kind=ANY($3::text[]) OR n.kind='service_down'
           OR ($6 AND n.kind='check' AND (n.dedupe_key LIKE 'check-system:%' OR n.text LIKE '⚠️ %'))))
         OR (n.kind='service_down' AND NOT EXISTS (
           SELECT 1 FROM service_health h WHERE h.name=split_part(n.dedupe_key,':',2)
           AND h.outage_started_at=n.line_outage_started_at))
         OR (n.kind='service_up' AND (n.line_outage_started_at IS NULL
           OR n.created_at<n.line_outage_started_at+$4::int*interval '1 minute'))
       )`,
      [
        expiredNote,
        allowedKinds === null,
        allowedKinds ?? [],
        lineServiceOutageMinutes,
        now,
        mode === "all" && lowQuota,
      ],
    );
    // 名單改變時另立摘要，避免用同一個重試鍵送出不同的內容。
    await c.query(
      `UPDATE notifications n SET line_digest_id=NULL
       WHERE n.group_id IS NULL AND n.sent_at IS NULL AND n.line_digest_id IN (
         SELECT u.line_digest_id FROM notifications u WHERE u.sent_at IS NOT NULL
         AND u.line_digest_id IS NOT NULL)`,
    );
    // 只有實際送出的摘要會開啟節流窗口；過期或只留在看板的通知也可能有 sent_at。
    const { rows } = await c.query<DigestItem>(
      `WITH eligible AS MATERIALIZED (
         SELECT n.id,n.text,n.created_at,n.line_digest_id
         FROM notifications n
         LEFT JOIN service_health h ON n.kind='service_down' AND h.name=split_part(n.dedupe_key,':',2)
         WHERE n.group_id IS NULL AND n.sent_at IS NULL AND n.attempts<3
         AND (n.kind<>'service_down' OR (h.reading_ok IS FALSE AND h.line_outage_confirmed
           AND h.outage_started_at=n.line_outage_started_at
           AND $3::timestamptz>=h.outage_started_at+$1::int*interval '1 minute'))
       ), anchor AS (
         SELECT * FROM eligible
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.group_id IS NULL AND n.line_digest_id IS NOT NULL AND n.last_error IS NULL
           AND n.sent_at>$3::timestamptz-$2::int*interval '1 minute')
         AND (line_digest_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM notifications n WHERE n.line_digest_id=eligible.line_digest_id
           AND NOT EXISTS (SELECT 1 FROM eligible x WHERE x.id=n.id)))
         ORDER BY (line_digest_id IS NULL),created_at,id LIMIT 1
       )
       SELECT e.id,e.text,e.line_digest_id FROM eligible e CROSS JOIN anchor f
       WHERE e.line_digest_id IS NOT DISTINCT FROM f.line_digest_id
       ORDER BY e.created_at,e.id`,
      [lineServiceOutageMinutes, linePrivateDigestMinutes, now],
    );
    if (!rows.length) return null;
    const id = rows[0].line_digest_id ?? randomUUID();
    const itemIds = rows.map((row) => row.id);
    if (!rows[0].line_digest_id)
      await c.query(
        "UPDATE notifications SET line_digest_id=$1 WHERE id=ANY($2::uuid[])",
        [id, itemIds],
      );
    return { id, itemIds, text: privateDigestText(rows, config().publicUrl) };
  });
}

/** 群組推播後，以已更新的用量判斷能否送出一則私訊摘要。 */
export async function flushLinePrivate(db: Database, access: string) {
  const settings = await db.settings();
  const to = settings.admin_line_id;
  if (!to || settings.admin_notify_platform === "discord") return;
  const reserve =
    settings.line_group_reserve_percent ??
    linePrivateDefaults.line_group_reserve_percent;
  const usage = await lineQuotaUsage(db);
  if (linePrivateQuotaHold(usage, reserve) || quotaRemaining(usage) === 0)
    return;
  const digest = await prepareDigest(
    db,
    settings.line_private_mode ?? linePrivateDefaults.line_private_mode,
    lineQuotaLow(usage, 1),
  );
  if (!digest) return;

  try {
    await new LineChatPlatform(access).sendToAdmin(to, digest.text, digest.id);
    // 寫回中斷時保留已提交的批次，下一輪用同一重試鍵確認 LINE 已收下原摘要。
    await db.transaction(async (c) => {
      if (usage) await saveQuotaUsage(db, { ...usage, used: usage.used + 1 }, c);
      await c.query(
        `UPDATE notifications SET sent_at=$3,attempts=attempts+1,
           last_error=CASE WHEN id=ANY($2::uuid[]) THEN NULL ELSE '已留在看板鈴鐺' END
         WHERE id=ANY($1::uuid[])`,
        [digest.itemIds, digest.itemIds.slice(0, 5), new Date()],
      );
    });
  } catch (error) {
    if (error instanceof LineQuotaExhausted) {
      const fresh = await fetchLineQuota(access).catch(() => null);
      await markQuotaExhausted(db, fresh ?? usage);
      return;
    }
    const detail = redact(String(error));
    await db.query(
      `UPDATE notifications SET attempts=(SELECT max(attempts)+1 FROM notifications WHERE id=ANY($1::uuid[])),
         last_error=$2 WHERE id=ANY($1::uuid[]) AND sent_at IS NULL`,
      [digest.itemIds, detail],
    );
    await recordLinePush(db, detail);
    return;
  }

  await recordLinePush(db);
}
