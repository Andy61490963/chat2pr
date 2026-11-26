import {
  parseUpstreamFailure,
  type UpstreamFailure,
  upstreamFailureText,
} from "../shared/upstream-failure.js";
import { subscriptionGateName } from "../shared/subscription-quota.js";
import { checkHostResources, parseResources } from "./capacity.js";
import type { Database } from "./db.js";
import type { Runner } from "./execution.js";
import { recordHealth } from "./health.js";
import { lineServiceOutageMinutes } from "../shared/line-private.js";

const inference = "codex_inference";
const interval = 6 * 3600_000;
type Prerequisite = { ok: boolean; detail: string; checked_at: Date };
type Reading = Prerequisite & { name: string; quota?: Prerequisite | null; inferenceStatus?: 'healthy' | 'failed' | 'unknown' };
const deferred = 'codex_probe_deferred';
const confirmation = lineServiceOutageMinutes * 60000;
const recoveryInterval = 2 * 3600000;
type Observation = { ok: boolean; checked_at: Date; outage_started_at: Date | null };

export function visibleHealth(rows: Reading[], now = Date.now(), skipped = '') {
  const probe = rows.find((row) => row.name === inference);
  const hold = rows.find(row => row.name === deferred);
  const host = rows.find(row => row.name === 'host_resources');
  const gate = rows.find(row => row.name === subscriptionGateName);
  const login = rows.find(row => row.name === 'codex');
  const reason = skipped || (gate && !gate.ok ? gate.detail : '') || (host && !host.ok ? host.detail : '') ||
    (hold && (!probe || Number(hold.checked_at) > Number(probe.checked_at)) ? hold.detail : '');
  const visible = rows.filter((row) => row.name !== inference && row.name !== deferred);
  for (const name of ["codex", subscriptionGateName]) {
    const index = visible.findIndex((row) => row.name === name);
    const prerequisite = visible[index];
    const unknown = reason || (!probe ? '尚未完成目前模型的真實推論檢查。' : now - Number(probe.checked_at) > interval + 120000 ? '真實推論讀數已過期。' : '');
    const result: Reading = login && !login.ok ? {
      ...login, name, inferenceStatus: 'failed',
    } : {
      ...probe,
      name, ok: !unknown && !!probe?.ok, inferenceStatus: unknown ? 'unknown' : probe?.ok ? 'healthy' : 'failed',
      detail: unknown ? `${unknown}${probe ? ` 上次真實讀數：${probe.detail}` : ''}` : probe!.detail,
      checked_at: probe?.checked_at ?? prerequisite?.checked_at ?? hold?.checked_at ?? new Date(now),
    };
    if (name === subscriptionGateName)
      result.quota = prerequisite
        ? {
            ok: prerequisite.ok,
            detail: prerequisite.detail,
            checked_at: prerequisite.checked_at,
          }
        : null;
    if (index < 0) visible.push(result);
    else visible[index] = result;
  }
  return visible;
}

export async function systemHealth(db: Database) {
  const [rows, settings] = await Promise.all([
    db.query<Reading>(`SELECT h.* FROM service_health h WHERE name NOT IN ('codex_inference','codex_probe_deferred') OR
      (probe_info->>'model') IS NOT DISTINCT FROM (SELECT value->>'codex_model' FROM settings WHERE id=1) ORDER BY name`),
    db.settings(),
  ]);
  if (settings.ai_mode === 'api') return rows.filter(row => row.name !== inference && row.name !== deferred);
  return visibleHealth(rows, Date.now(), settings.paused ? '派工暫停中，未送出推論。' : '');
}

export function lastInference(db: Database, model: string | null) {
  return db.one<Observation>(`SELECT ok,checked_at,outage_started_at FROM service_health WHERE name=$1
    AND reading_ok IS NOT NULL AND (probe_info->>'model') IS NOT DISTINCT FROM $2`, [inference, model]);
}

export async function recordWorkInference(db: Database, model: string | null, started: Date) {
  await recordHealth(db, inference, true, '已從實際訂閱工作的成功推論確認可用。', {
    inferenceObservation: { model, started }, probe: { model, latencyMs: null },
  });
}

type Capacity = { known: boolean; hold: string | null };
export async function recordWorkInferenceFailure(db: Database, model: string | null, started: Date, failure: UpstreamFailure) {
  const upstream = ['upstream_http','connection','redirect','auth','missing_body','invalid_stream','invalid_event','stream_error','invalid_usage','duplicate_completion','stream_interrupted'];
  if (!upstream.includes(failure.kind) && !(failure.kind === 'quota' && failure.status !== undefined)) return;
  await recordHealth(db, inference, false, `實際訂閱工作推論失敗：${upstreamFailureText(failure)}。請檢查訂閱代理。`, {
    inferenceObservation: { model, started }, probe: { model, latencyMs: null, failure }, firstWorkFailure: true,
  });
}

export function capacitySample(read: () => Promise<Capacity>) {
  let pending: Promise<Capacity> | undefined;
  return () => (pending ??= read());
}

export async function readCapacity(
  db: Database,
  runner: Runner,
): Promise<Capacity> {
  let known = false;
  const hold = await checkHostResources(db, async () => {
    const resources = parseResources(await runner.call("resources", {}, 5000));
    known = !!resources;
    return resources;
  });
  return { known, hold };
}

export class InferenceSchedule {
  private retryAfter = 0;
  private requestedAt = -Infinity;
  private probing = false;
  private active?: Promise<void>;
  private last?: Observation;
  constructor(private now = Date.now, private read?: (model: string | null) => Promise<Observation | undefined>) {}

  request() {
    if (!this.probing) this.requestedAt = this.now();
  }

  private model?: string | null;
  tick(
    probe: (early: boolean) => Promise<boolean | "failed" | "unavailable">,
    model: string | null = null,
  ) {
    if (this.active) return this.active;
    if (model !== this.model) { this.model = model; this.last = undefined; this.retryAfter = 0; }
    if (this.now() < this.retryAfter) return;
    this.active = (async () => {
      const last = this.read ? await this.read(model) : this.last;
      if (last) {
        const elapsedOutage = Number(last.checked_at) - Number(last.outage_started_at ?? last.checked_at);
        const repeat = last.ok ? (this.requestedAt >= Number(last.checked_at) ? confirmation : interval) :
          elapsedOutage < confirmation ? confirmation : elapsedOutage < recoveryInterval ? recoveryInterval : interval;
        if (this.now() < Number(last.checked_at) + repeat) return;
      }
      this.probing = true;
      const completed = await probe(!!last?.ok && this.now() < Number(last.checked_at) + interval);
      if (completed === 'unavailable') { this.retryAfter = this.now() + 60000; return; }
      if (!completed) return;
      this.requestedAt = -Infinity;
      this.last = { ok: completed === true, checked_at: new Date(this.now()), outage_started_at: completed === true ? null : last?.outage_started_at ?? new Date(this.now()) };
    })()
      .finally(() => {
        this.probing = false;
        this.active = undefined;
      });
    return this.active;
  }

  idle() {
    return this.active;
  }
}

export async function probeInference(
  db: Database,
  runner: Runner,
  revision: string,
  capacity = () => readCapacity(db, runner),
  early = false,
) {
  const eligible = async () => {
    const snapshot = await db.settingsSnapshot();
    return snapshot.revision === revision &&
      !snapshot.value.paused &&
      snapshot.value.ai_mode === "subscription"
      ? snapshot.value
      : null;
  };
  if (!(await eligible())) return false;
  const sample = await capacity();
  if (sample.hold) return false;
  const settings = await eligible();
  if (!settings) return false;
  const model = settings.codex_model ?? null;
  const skip = async (detail: string) => {
    await recordHealth(db, deferred, false, detail, { silent: true, probe: { model, latencyMs: null } });
    return 'unavailable' as const;
  };
  if (!sample.known) {
    return skip('讀不到主機資源，未送出真實推論；一分鐘後再檢查。');
  }
  const reservation = await db.one<{ receipt: string }>(`INSERT INTO inference_probe_budget AS budget(id,day,attempts,reserved_at,early_attempts)
    VALUES(true,(now() AT TIME ZONE 'Asia/Taipei')::date,0,now(),0)
    ON CONFLICT(id) DO UPDATE SET day=excluded.day,reserved_at=now(),
      early_attempts=CASE WHEN budget.day<excluded.day THEN 0 ELSE budget.early_attempts END,
      attempts=CASE WHEN budget.day<excluded.day THEN 0 ELSE budget.attempts END
    WHERE (budget.reserved_at IS NULL OR budget.reserved_at<=now()-interval '15 minutes') AND
    (budget.day<excluded.day OR (budget.day=excluded.day AND budget.early_attempts+$3<=2 AND budget.attempts<CASE WHEN EXISTS (
      SELECT 1 FROM service_health WHERE name=$1 AND NOT ok AND (probe_info->>'model') IS NOT DISTINCT FROM $2
    ) THEN 8 ELSE 6 END)) RETURNING reserved_at::text AS receipt`, [inference, model, early ? 1 : 0]);
  if (!reservation) {
    const wait = await db.one<{ cooling: boolean }>("SELECT reserved_at>now()-interval '15 minutes' AS cooling FROM inference_probe_budget WHERE id");
    if (wait?.cooling) return 'unavailable';
    return skip(early ? '今日提早補測的次數已用完，仍會依原排程確認推論。' : '今日可用的推論探測次數已用完，最後兩次僅供異常後確認。');
  }
  const started = Date.now();
  let ok = false;
  let detail: string;
  let failure: ReturnType<typeof parseUpstreamFailure>;
  let completedOverLimit = false;
  try {
    const sent = Date.now();
    const result = await runner.call<{ ok: boolean; failure?: unknown; skipped?: string }>(
      "codex/inference-probe",
      {
        model: settings.codex_model ?? null,
        reservePercent: settings.codex_reserve_percent ?? 0,
      },
      45000,
    );
    ok = result.ok === true;
    failure = parseUpstreamFailure(result.failure);
    completedOverLimit = !ok && result.skipped === 'output_limit';
    if (!ok && !failure && !completedOverLimit) return skip('未取得可確認的推論結果，請檢查訂閱代理。');
    if (!ok && failure && ['quota','quota_unavailable','concurrent_request'].includes(failure.kind) && failure.status === undefined)
      return skip(`${upstreamFailureText(failure)}，未送出真實推論。`);
    const latency = Date.now() - sent;
    detail = ok
      ? `真實推論成功，耗時 ${latency} 毫秒。`
      : `真實推論未通過：${failure ? upstreamFailureText(failure) : "未取得有效的完成回應"}。耗時 ${latency} 毫秒，請檢查訂閱代理。`;
  } catch {
    return skip('無法取得推論檢查結果，請確認執行器與主機資源連線。');
  }
  if (!(await eligible())) return false;
  await db.query(`UPDATE inference_probe_budget SET attempts=attempts+1,early_attempts=early_attempts+$2
    WHERE id AND reserved_at=$1::timestamptz`, [reservation.receipt, early ? 1 : 0]);
  if (completedOverLimit) return skip('探測輸出超過本地上限，無法確認推論健康。');
  await recordHealth(db, inference, ok, detail, {
    inferenceObservation: { model, started: new Date(started) },
    probe: {
      model: settings.codex_model ?? null,
      latencyMs: Date.now() - started,
      failure,
    },
  });
  return ok || ("failed" as const);
}
