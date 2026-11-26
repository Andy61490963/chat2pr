import {
  parseUpstreamFailure,
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
type Reading = Prerequisite & { name: string; quota?: Prerequisite | null };

export function visibleHealth(rows: Reading[], now = Date.now()) {
  const probe = rows.find((row) => row.name === inference);
  const visible = rows.filter((row) => row.name !== inference);
  for (const name of ["codex", subscriptionGateName]) {
    const index = visible.findIndex((row) => row.name === name);
    const prerequisite = visible[index];
    if (prerequisite?.ok === false || (!probe && !prerequisite)) continue;
    const reading = probe
      ? probe.ok && now - Number(probe.checked_at) > interval + 120_000
        ? {
            ...probe,
            ok: false,
            detail: "真實推論讀數已過期，請確認派工與主機記憶體狀態。",
          }
        : probe
      : {
          ...prerequisite,
          ok: false,
          detail: "尚未完成真實推論檢查，登入或額度正常不代表可推論。",
        };
    const result: Reading = { ...reading, name };
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
  return visibleHealth(
    await db.query<Reading>(`SELECT h.* FROM service_health h WHERE name<>'codex_inference' OR
      (probe_info->>'model') IS NOT DISTINCT FROM (SELECT value->>'codex_model' FROM settings WHERE id=1) ORDER BY name`),
  );
}

type Capacity = { known: boolean; hold: string | null };
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
  private next = 0;
  private pending = true;
  private active?: Promise<void>;
  constructor(private now = Date.now) {}

  request() {
    this.pending = true;
  }

  private model?: string | null;
  private failedSince?: number;
  tick(
    probe: () => Promise<boolean | "failed" | "unavailable">,
    model: string | null = null,
  ) {
    if (model !== this.model) {
      this.model = model;
      this.failedSince = undefined;
      this.request();
    }
    if (this.active || (!this.pending && this.now() < this.next))
      return this.active;
    this.pending = false;
    this.active = probe()
      .then((completed) => {
        if (completed === "failed") {
          this.failedSince ??= this.now();
          const confirmation =
            this.failedSince + lineServiceOutageMinutes * 60000;
          this.next =
            confirmation > this.now() ? confirmation : this.now() + interval;
        } else if (completed === "unavailable") this.next = this.now() + 60000;
        else if (completed) {
          this.failedSince = undefined;
          this.next = this.now() + interval;
        } else this.pending = true;
      })
      .finally(() => {
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
  if (!sample.known) {
    await recordHealth(
      db,
      inference,
      false,
      "讀不到主機資源，未送出真實推論；一分鐘後再檢查。",
      { silent: true, probe: { model: settings.codex_model ?? null, latencyMs: null } },
    );
    return "unavailable" as const;
  }
  const started = Date.now();
  let ok = false;
  let detail: string;
  let failure: ReturnType<typeof parseUpstreamFailure>;
  try {
    const sent = Date.now();
    const result = await runner.call<{ ok: boolean; failure?: unknown }>(
      "codex/inference-probe",
      {
        model: settings.codex_model ?? null,
        reservePercent: settings.codex_reserve_percent ?? 0,
      },
      45000,
    );
    ok = result.ok === true;
    failure = parseUpstreamFailure(result.failure);
    const latency = Date.now() - sent;
    detail = ok
      ? `真實推論成功，耗時 ${latency} 毫秒。`
      : `真實推論未通過：${failure ? upstreamFailureText(failure) : "未取得有效的完成回應"}。耗時 ${latency} 毫秒，請檢查訂閱代理。`;
  } catch {
    detail = `無法完成真實推論檢查，耗時 ${Date.now() - started} 毫秒。請確認執行器與主機資源連線。`;
  }
  if (!(await eligible())) return false;
  await recordHealth(db, inference, ok, detail, {
    probe: {
      model: settings.codex_model ?? null,
      latencyMs: Date.now() - started,
      failure,
    },
  });
  return ok || ("failed" as const);
}
