import { activityStatusLabels } from "./status-glossary.js";
import { parseFailure } from "./failure-text.js";
import type { Task } from "./types.js";

export type ActivityEvent = {
  id: number | string;
  task_id: string | null;
  kind: string;
  detail: string;
  created_at: string;
  task_title?: string | null;
  task_mode?: Task["mode"] | null;
};

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const activityDay = (value: string | Date) =>
  dayFormat.format(new Date(value));

const systemKinds = new Set([
  "ai_output_adjusted",
  "api_error",
  "api_stream_error",
  "backup",
  "build_output_excluded",
  "check_environment",
  "check_host_unavailable",
  "check_system_issue",
  "defer",
  "install_image",
  "install_review",
  "install_retry",
  "install_skipped",
  "proxy_rejected",
  "query_note",
  "rag",
  "recovery",
  "retrieval",
  "started",
  "triage_skipped",
  "tunnel_brief_outage",
]);

export function isSystemActivity({ kind, detail }: ActivityEvent) {
  // 每天的例行清理幾乎都會清掉一點建置快取，放在主要動態只是雜訊；磁碟不足另有通知。
  if (kind === "docker_cleanup") return true;
  if (kind === "docker_disk_auto") {
    return /^Docker 自動清理（[^）]+）：(?:沒有符合規則的項目$|刪除 0 項；約釋放 0\.0 GB(?:；|$))/.test(
      detail,
    );
  }
  return (
    systemKinds.has(kind) ||
    (kind === "memory" && /^(AI 自動記住|群組記住)：/.test(detail))
  );
}

type ActivityStep = { event: ActivityEvent; times: number };
export type ActivityGroup = {
  key: string;
  day: string;
  latest: ActivityEvent;
  steps: ActivityStep[];
};

export function groupActivity(
  events: readonly ActivityEvent[],
  includeSystem = false,
): ActivityGroup[] {
  const groups = new Map<
    string,
    Omit<ActivityGroup, "steps"> & { steps: Map<string, ActivityStep> }
  >();
  // 依時間新到舊選出摘要，同一時間沿用 API 的排序。
  const sorted = [...events].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  for (const event of sorted) {
    const system = isSystemActivity(event);
    if (system && !includeSystem) continue;
    const day = activityDay(event.created_at);
    // 既有稽核把操作者及操作對象記在文字裡。以完整原文比對，避免不同操作被合併。
    const operation = JSON.stringify([event.kind, event.detail]);
    const key = JSON.stringify([
      day,
      event.task_id,
      event.task_id ? null : operation,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = { key, day, latest: event, steps: new Map() };
      groups.set(key, group);
    } else if (!system && isSystemActivity(group.latest)) {
      group.latest = event;
    }
    const step = group.steps.get(operation);
    if (step) step.times++;
    else group.steps.set(operation, { event, times: 1 });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, steps: [...group.steps.values()].reverse() }))
    .sort(
      (a, b) =>
        Date.parse(b.latest.created_at) - Date.parse(a.latest.created_at),
    );
}

export function activityDetail(event: ActivityEvent) {
  const { kind, detail, task_mode } = event;
  if (kind === "answered" && /^查詢已回覆[：:]/.test(detail))
    return activityStatusLabels.queryAnswered;
  if (kind === "settings") return detail.replaceAll(" → ", " 改為 ");
  if (task_mode === "query") {
    if (kind === "attempt" && detail === "開始程式修改")
      return activityStatusLabels.investigationStarted;
    if (kind === "started")
      return detail.replace(
        /^開始開發/,
        activityStatusLabels.investigationStarted,
      );
  }
  if (kind !== "verification" && kind !== "error") return detail;
  const failure = kind === "error" ? parseFailure(detail) : null;
  if (failure)
    return `這次執行未完成。${failure.plain}。建議${failure.action}。`;
  if (detail.startsWith("驗證未通過，請修正：")) return "驗證未通過，交回修正";
  const gaveUp = "一次自動修復後仍未通過驗證";
  const at = detail.indexOf(gaveUp);
  if (at >= 0) return detail.slice(0, at + gaveUp.length);
  return detail.split("\n")[0];
}

export function activityStatus(event: ActivityEvent) {
  const detail = activityDetail(event);
  switch (event.kind) {
    case "answered":
      return activityStatusLabels.answered;
    case "ready":
      return activityStatusLabels.ready;
    case "error":
      return activityStatusLabels.failed;
    case "attempt":
      if (detail === activityStatusLabels.investigationStarted)
        return activityStatusLabels.investigationRunning;
      break;
    case "triage":
      if (detail.endsWith(activityStatusLabels.scheduled))
        return activityStatusLabels.scheduled;
      break;
  }
  return detail;
}
