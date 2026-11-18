/**
 * 執行中任務的一行進度：「<階段>・已 12 分／期限 14:30」。
 * 看板任務列（`/api/state` 的 run_* 欄位）、任務詳情標頭與執行紀錄共用，
 * 心跳逾時的判斷也只寫在這裡。
 */
import { phaseLabels } from "./observation.js";

/** 服務心跳超過這麼久沒更新，就不能確定工作還在跑。 */
export const HEARTBEAT_STALE_MS = 30000;

export function heartbeatStale(
  heartbeatAt: string | null | undefined,
  now = Date.now(),
) {
  return (
    !!heartbeatAt && now - new Date(heartbeatAt).getTime() > HEARTBEAT_STALE_MS
  );
}

const clock = (v: string) =>
  new Date(v).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const elapsed = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "剛開始";
  if (m < 60) return `已 ${m} 分`;
  return `已 ${Math.floor(m / 60)} 小時 ${m % 60} 分`;
};

export interface RunProgressInput {
  phase: string | null | undefined;
  startedAt: string | null | undefined;
  deadline?: string | null;
  heartbeatAt?: string | null;
}

/** 沒有進行中的執行（沒有階段或開始時間）時回傳 null。 */
export function runProgress(run: RunProgressInput, now = Date.now()) {
  if (!run.phase || !run.startedAt) return null;
  const label = phaseLabels[run.phase] ?? run.phase;
  const stale = heartbeatStale(run.heartbeatAt, now);
  const spent = elapsed(now - new Date(run.startedAt).getTime());
  const due = run.deadline ? `／期限 ${clock(run.deadline)}` : "";
  return {
    stale,
    text: stale ? `${label}・狀態待確認` : `${label}・${spent}${due}`,
  };
}
