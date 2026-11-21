import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { lineServiceOutageMinutes } from "../shared/line-private.js";
import { serviceDownText } from "../shared/service-health-text.js";
import { notificationLabels } from "../shared/status-glossary.js";

// 會讓收訊、派工或通知停擺的服務；其餘項目只在設定頁顯示。
const critical: Record<string, string> = {
  line: "LINE",
  github: "GitHub App",
  codex: "Codex 訂閱登入",
  openai: "OpenAI API",
  runner: "隔離執行器",
  tunnel: "HTTPS 入口",
  host_resources: "主機資源",
};

type HealthReading = {
  ok: boolean;
  notified_ok: boolean | null;
  reading_ok: boolean | null;
  checked_at: Date;
  outage_started_at: Date | null;
  line_outage_confirmed?: boolean;
};

const minute = 60_000;
const tunnelNoticeDelay = 5 * minute;

export function healthTransition(
  name: string,
  before: HealthReading,
  ok: boolean,
  detail: string,
  observedAt: Date,
  confirm: boolean,
) {
  const label = critical[name];
  const baseline = before.notified_ok ?? before.ok;
  const confirmed = !confirm || before.reading_ok === ok;
  let notifiedOk = baseline;
  let outageStartedAt = before.outage_started_at;
  let lineOutageConfirmed = before.line_outage_confirmed ?? false;
  let notice: { kind: "service_up" | "service_down"; text: string } | null =
    null;
  let briefOutage: string | null = null;

  if (!ok && confirmed) {
    outageStartedAt ??=
      before.reading_ok === false ? before.checked_at : observedAt;
  }
  const elapsed = outageStartedAt
    ? observedAt.getTime() - outageStartedAt.getTime()
    : 0;
  if (!ok && confirmed && elapsed >= lineServiceOutageMinutes * minute)
    lineOutageConfirmed = true;

  if (ok && confirmed) {
    if (name === "tunnel" && outageStartedAt) {
      // 用首次正常讀數計算中斷時間，第二次讀數只用來確認恢復。
      const recoveredAt = confirm ? before.checked_at : observedAt;
      const duration = recoveredAt.getTime() - outageStartedAt.getTime();
      const minutes = Math.max(1, Math.round(duration / minute));
      if (duration < tunnelNoticeDelay) {
        briefOutage = `${label}中斷約 ${minutes} 分鐘後恢復`;
      } else {
        notice = {
          kind: "service_up",
          text: baseline
            ? `${label}曾中斷約 ${minutes} 分鐘，已恢復。`
            : `${notificationLabels.serviceUp}：${label}`,
        };
      }
    } else if (!baseline) {
      notice = {
        kind: "service_up",
        text: `${notificationLabels.serviceUp}：${label}`,
      };
    }
    notifiedOk = true;
    outageStartedAt = null;
    lineOutageConfirmed = false;
  } else if (
    !ok &&
    baseline &&
    confirmed &&
    (name !== "tunnel" || elapsed >= tunnelNoticeDelay)
  ) {
    notice = {
      kind: "service_down",
      text: serviceDownText(name, label, detail),
    };
    notifiedOk = false;
  }
  return {
    notifiedOk,
    outageStartedAt,
    lineOutageConfirmed,
    notice,
    briefOutage,
  };
}

/**
 * 第一次觀察建立基準；confirm 以連續兩次真實讀數確認轉換。
 * silent 更新目前狀態與說明，保留真實讀數及通知基準。
 * trackOutage 讓不發服務異常通知的項目也能保留同一次異常的開始時間。
 */
export async function recordHealth(
  db: Database,
  name: string,
  ok: boolean,
  detail: string,
  options: { confirm?: boolean; silent?: boolean; trackOutage?: boolean } = {},
) {
  if (options.silent || !Object.hasOwn(critical, name)) {
    await db.query(
      `INSERT INTO service_health(name,ok,detail,reading_ok,outage_started_at)
       VALUES($1,$2,$3,$4,CASE WHEN $5 AND NOT $2 THEN now() END)
       ON CONFLICT(name) DO UPDATE SET ok=$2,detail=$3,checked_at=now(),
       reading_ok=coalesce($4,service_health.reading_ok),
       outage_started_at=CASE WHEN NOT $5 THEN service_health.outage_started_at
         WHEN $2 THEN NULL
         ELSE coalesce(service_health.outage_started_at,now()) END`,
      [
        name,
        ok,
        detail,
        options.silent ? null : ok,
        options.trackOutage ?? false,
      ],
    );
    return;
  }

  // 同一服務的探測依資料列鎖序列化，狀態與通知一起提交。
  await db.transaction(async (c) => {
    // 入口剛啟動時也要等中斷確認並達門檻，才改變通知基準。
    const inserted = await c.query(
      `INSERT INTO service_health(name,ok,detail,reading_ok,notified_ok)
       VALUES($1,$2,$3,$2,$4) ON CONFLICT(name) DO NOTHING RETURNING name`,
      [name, ok, detail, name === "tunnel" || ok],
    );
    if (inserted.rowCount) return;
    const {
      rows: [before],
    } = await c.query<HealthReading>(
      "SELECT * FROM service_health WHERE name=$1 FOR UPDATE",
      [name],
    );
    const {
      rows: [{ observed_at: observedAt }],
    } = await c.query<{ observed_at: Date }>(
      "SELECT clock_timestamp() AS observed_at",
    );
    const {
      notifiedOk,
      outageStartedAt,
      lineOutageConfirmed,
      notice,
      briefOutage,
    } = healthTransition(
      name,
      before,
      ok,
      detail,
      observedAt,
      options.confirm ?? false,
    );
    await c.query(
      `UPDATE service_health SET ok=$2,detail=$3,reading_ok=$2,checked_at=$4,
       notified_ok=$5,outage_started_at=$6,line_outage_confirmed=$7 WHERE name=$1`,
      [
        name,
        ok,
        detail,
        observedAt,
        notifiedOk,
        outageStartedAt,
        lineOutageConfirmed,
      ],
    );
    if (briefOutage) {
      await c.query(
        "INSERT INTO audit(kind,detail,created_at) VALUES('tunnel_brief_outage',$1,$2)",
        [briefOutage, observedAt],
      );
    }
    if (notice) {
      const noticeOutage = ok
        ? before.line_outage_confirmed
          ? before.outage_started_at
          : null
        : outageStartedAt;
      // 恢復通知以服務與中斷起點去重，舊資料沒有中斷起點時沿用資料列鎖。
      const noticeId =
        ok && before.outage_started_at
          ? before.outage_started_at.toISOString()
          : randomUUID();
      await c.query(
        `INSERT INTO notifications(kind,dedupe_key,text,created_at,line_outage_started_at)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING`,
        [
          notice.kind,
          `service:${name}:${ok ? "up" : "down"}:${noticeId}`,
          notice.text,
          observedAt,
          noticeOutage,
        ],
      );
    }
  });
}
