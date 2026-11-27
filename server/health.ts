import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { lineServiceOutageMinutes } from "../shared/line-private.js";
import { serviceDownText } from "../shared/service-health-text.js";
import { notificationLabels } from "../shared/status-glossary.js";
import type { UpstreamFailure } from "../shared/upstream-failure.js";

// 會讓收訊、派工或通知停擺的服務；其餘項目只在設定頁顯示。
const critical: Record<string, string> = {
  line: "LINE",
  github: "GitHub App",
  codex: "Codex 訂閱登入",
  codex_inference: "Codex 訂閱推論",
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
  probe_info?: { started?: string; model?: string | null } | null;
};

const minute = 60_000;
/**
 * 異常要持續這麼久才通知；更短的中斷只留在看板（入口另記一筆系統紀錄）。
 * 入口：部署重啟與 Cloudflare 短暫 502 約一分鐘內恢復。
 * 主機資源：記憶體暫停派工至少維持 5 分鐘穩定期（見 capacity.ts），短暫低點不值得通知。
 */
export const noticeDelay: Readonly<Record<string, number>> = {
  codex_inference: lineServiceOutageMinutes * minute,
  tunnel: 5 * minute,
  host_resources: 10 * minute,
  stuck_tasks: 10 * minute,
};

export function healthTransition(
  name: string,
  before: HealthReading,
  ok: boolean,
  detail: string,
  observedAt: Date,
  confirm: boolean,
) {
  const label = critical[name];
  const baseline = before.notified_ok ?? (name === "codex_inference" && before.reading_ok === null ? true : before.ok);
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

  const delay = noticeDelay[name] ?? 0;
  if (ok && confirmed) {
    // 用首次正常讀數計算中斷時間，第二次讀數只用來確認恢復。
    const recoveredAt = confirm ? before.checked_at : observedAt;
    const duration = outageStartedAt
      ? recoveredAt.getTime() - outageStartedAt.getTime()
      : 0;
    const minutes = Math.max(1, Math.round(duration / minute));
    if (!baseline) {
      notice = {
        kind: "service_up",
        text: `${notificationLabels.serviceUp}：${label}`,
      };
    } else if (name !== "codex_inference" && delay && outageStartedAt && duration >= delay) {
      // 異常通知前就恢復，但中斷已達門檻：補一則說明中斷多久。
      notice = {
        kind: "service_up",
        text: `${label}曾中斷約 ${minutes} 分鐘，已恢復。`,
      };
    } else if (name === "tunnel" && outageStartedAt) {
      briefOutage = `${label}中斷約 ${minutes} 分鐘後恢復`;
    }
    notifiedOk = true;
    outageStartedAt = null;
    lineOutageConfirmed = false;
  } else if (!ok && baseline && confirmed && elapsed >= delay) {
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
  options: {
    confirm?: boolean; silent?: boolean; trackOutage?: boolean;
    probe?: { model: string | null; latencyMs: number | null; failure?: UpstreamFailure };
    inferenceObservation?: { model: string | null; started: Date };
    firstWorkFailure?: boolean;
  } = {},
) {
  const observation = options.inferenceObservation;
  if (name === "codex_inference" && (!observation || options.silent)) return;
  if (options.silent || !Object.hasOwn(critical, name)) {
    await db.query(
      `INSERT INTO service_health(name,ok,detail,reading_ok,outage_started_at,probe_info)
       VALUES($1,$2,$3,$4,CASE WHEN $5 AND NOT $2 THEN now() END,$6)
       ON CONFLICT(name) DO UPDATE SET ok=$2,detail=$3,checked_at=now(),
       reading_ok=coalesce($4,service_health.reading_ok),probe_info=excluded.probe_info,
       outage_started_at=CASE WHEN NOT $5 THEN service_health.outage_started_at
         WHEN $2 THEN NULL
         ELSE coalesce(service_health.outage_started_at,now()) END`,
      [
        name,
        ok,
        detail,
        options.silent ? null : ok,
        options.trackOutage ?? false,
        options.probe,
      ],
    );
    return;
  }

  // 同一服務的探測依資料列鎖序列化，狀態與通知一起提交。
  await db.transaction(async (c) => {
    if (observation) {
      const eligible = await c.query(
        `SELECT id FROM settings WHERE id=1 AND value->>'ai_mode'='subscription'
         AND (value->>'codex_model') IS NOT DISTINCT FROM $1::text
         AND $2::timestamptz >= coalesce((value->>'inference_configured_at')::timestamptz,'-infinity')
         FOR SHARE`,
        [observation.model, observation.started],
      );
      if (!eligible.rowCount) return;
    }
    const probe = observation ? { ...options.probe, ...observation } : options.probe;
    // 有通知門檻的項目剛啟動時也要等中斷確認並達門檻，才改變通知基準。
    const inserted = await c.query(
      `INSERT INTO service_health(name,ok,detail,reading_ok,notified_ok,probe_info,checked_at,outage_started_at)
       SELECT $1,$2,$3,$2,$4,$5,coalesce(outage,now()),outage FROM
         (SELECT CASE WHEN $1='codex_inference' AND NOT $2 THEN date_trunc('milliseconds',now()) END AS outage) initial
       ON CONFLICT(name) DO NOTHING RETURNING name`,
      [name, ok, detail, Object.hasOwn(noticeDelay, name) || ok, probe],
    );
    const before = inserted.rowCount ? undefined : (await c.query<HealthReading>(
      "SELECT * FROM service_health WHERE name=$1 FOR UPDATE",
      [name],
    )).rows[0];
    if (observation && before?.probe_info?.started &&
        Date.parse(before.probe_info.started) >= observation.started.getTime()) return;
    if (options.firstWorkFailure && before?.reading_ok === false && before.probe_info?.model === observation?.model) return;
    if (observation) {
      await c.query(
        `DELETE FROM service_health WHERE name='codex_probe_deferred'
         AND (probe_info->>'model') IS NOT DISTINCT FROM $1::text AND checked_at<=now()`,
        [observation.model],
      );
    }
    if (!before) return;
    const {
      rows: [{ observed_at: observedAt, precise_at: preciseAt }],
    } = await c.query<{ observed_at: Date; precise_at: string }>(
      "SELECT observed_at, observed_at::text AS precise_at FROM clock_timestamp() AS observed_at",
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
       notified_ok=$5,outage_started_at=$6,line_outage_confirmed=$7,probe_info=$8 WHERE name=$1`,
      [
        name,
        ok,
        detail,
        observation ? preciseAt : observedAt,
        notifiedOk,
        outageStartedAt,
        lineOutageConfirmed,
        probe,
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
