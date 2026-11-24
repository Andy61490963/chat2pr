/**
 * Codex 訂閱上游失敗的固定類別（#264）。
 *
 * 訂閱代理只把上游結果歸成這些列舉值，連同上游 HTTP 狀態碼（只有數字）交給應用程式；
 * 上游的錯誤字串、標頭與回應內容都不會離開代理。
 */
export const upstreamFailureKinds = {
  server_error: { label: "上游伺服器錯誤", retry: true },
  connection: { label: "連不上上游", retry: true },
  stream_interrupted: { label: "串流在完成前中斷", retry: true },
  stream_error: { label: "串流回報失敗事件", retry: true },
  invalid_response: { label: "上游回應格式無效", retry: true },
  rejected: { label: "上游拒絕請求", retry: false },
  context_too_long: { label: "對話超過模型上限", retry: false },
  model_unavailable: { label: "模型不可用", retry: false },
  auth: { label: "登入失效", retry: false },
  quota: { label: "額度已達上限", retry: false },
} as const;

export type UpstreamFailureKind = keyof typeof upstreamFailureKinds;

export interface UpstreamFailure {
  kind: UpstreamFailureKind;
  /** 上游 HTTP 狀態碼；串流階段的失敗沒有。 */
  status?: number;
}

/**
 * 串流失敗事件的錯誤代碼白名單；只看結構化的 code／type，不看 message。
 * 不在表內的代碼一律記成 stream_error。
 */
export const upstreamErrorCodes: Record<string, UpstreamFailureKind> = {
  usage_limit_reached: "quota",
  rate_limit_exceeded: "quota",
  context_length_exceeded: "context_too_long",
  model_not_found: "model_unavailable",
  server_error: "server_error",
  server_is_overloaded: "server_error",
  invalid_request_error: "rejected",
  invalid_prompt: "rejected",
};

/** 上游 HTTP 回應失敗時的類別；401、429 另有既有的處理。 */
export function httpFailureKind(status: number): UpstreamFailureKind {
  if (status === 401) return "auth";
  if (status === 429) return "quota";
  if (status >= 500) return "server_error";
  return "rejected";
}

/** 執行器回應的邊界檢查：只接受固定類別與三位數狀態碼。 */
export function parseUpstreamFailure(value: unknown): UpstreamFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, status } = value as { kind?: unknown; status?: unknown };
  if (typeof kind !== "string" || !Object.hasOwn(upstreamFailureKinds, kind))
    return undefined;
  return {
    kind: kind as UpstreamFailureKind,
    ...(Number.isInteger(status) &&
    (status as number) >= 100 &&
    (status as number) <= 599
      ? { status: status as number }
      : {}),
  };
}

/** 「上游伺服器錯誤（HTTP 503）」：執行事件、健康項目與錯誤重點共用。 */
export function upstreamFailureText(f: UpstreamFailure) {
  return `${upstreamFailureKinds[f.kind].label}${f.status ? `（HTTP ${f.status}）` : ""}`;
}

/** 上游暫時故障時的自動重試間隔（秒）：次數上限就是陣列長度。 */
export const UPSTREAM_RETRY_DELAYS = [30, 180, 600] as const;

/** 等待上游恢復時寫在 `tasks.last_error` 的開頭；排隊原因靠它顯示「等待 AI 服務恢復」。 */
export const upstreamWaitPrefix = "等待 AI 服務恢復";

/** 系統頁的 Codex 服務回應健康項目名稱。 */
export const upstreamHealthName = "codex_upstream";

/** 30 → 「30 秒」，180 → 「3 分鐘」。 */
export const waitText = (seconds: number) =>
  seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分鐘`;
