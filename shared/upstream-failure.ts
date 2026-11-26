const reasons = {
  model_denied: "這個訂閱階段不允許使用指定的模型",
  invalid_request: "訂閱代理收到不符合要求的推論請求",
  invalid_tools: "訂閱代理收到無效的工具宣告",
  tool_denied: "訂閱代理不允許使用請求中的工具",
  tool_limit: "訂閱代理收到的工具宣告超過上限",
  tool_choice_denied: "訂閱代理不允許選擇指定的工具",
  phase_deadline: "訂閱階段已超過期限",
  phase_cancelled: "訂閱階段已取消",
  concurrent_request: "同一訂閱階段已有進行中的呼叫",
  usage_limit: "訂閱工作已達應用程式用量上限",
  request_limit: "訂閱請求超過用量限制",
  upstream_http: "訂閱上游回應失敗",
  connection: "無法連上訂閱服務",
  redirect: "訂閱上游要求重新導向",
  auth: "訂閱登入已失效或無法刷新",
  quota: "Codex 訂閱額度已達上限",
  quota_unavailable: "無法確認訂閱額度，已暫停新的推論",
  missing_body: "訂閱上游未回傳內容",
  invalid_stream: "訂閱上游未回傳有效串流",
  response_limit: "訂閱回應大小超過上限",
  frame_limit: "訂閱回應的單一事件過大",
  invalid_event: "訂閱回應的事件格式無效",
  stream_error: "訂閱推論串流回報錯誤",
  invalid_usage: "訂閱回應缺少有效用量",
  duplicate_completion: "訂閱回應重複回報完成",
  output_limit: "訂閱工作的輸出用量已達應用程式上限",
  stream_interrupted: "訂閱串流在完成前中斷",
  protected_data: "訂閱上游回應包含受保護資料，已停止傳送",
};

export interface UpstreamFailure {
  kind: keyof typeof reasons;
  status?: number;
}

const retryPolicy = {
  upstream_http: "5xx",
  connection: true,
  invalid_stream: true,
  stream_interrupted: true,
  model_denied: false,
  invalid_request: false,
  invalid_tools: false,
  tool_denied: false,
  tool_limit: false,
  tool_choice_denied: false,
  phase_deadline: false,
  phase_cancelled: false,
  concurrent_request: false,
  usage_limit: false,
  request_limit: false,
  redirect: false,
  auth: false,
  quota: false,
  quota_unavailable: false,
  missing_body: false,
  response_limit: false,
  frame_limit: false,
  invalid_event: false,
  stream_error: false,
  invalid_usage: false,
  duplicate_completion: false,
  output_limit: false,
  protected_data: false,
} satisfies Record<UpstreamFailure["kind"], boolean | "5xx">;

export function isRetryableUpstreamFailure(failure: UpstreamFailure): boolean {
  const policy = retryPolicy[failure.kind];
  if (policy === "5xx")
    return failure.status !== undefined && failure.status >= 500 && failure.status <= 599;
  return policy;
}

function isKind(value: unknown): value is UpstreamFailure["kind"] {
  return typeof value === "string" && Object.hasOwn(reasons, value);
}

export function parseUpstreamFailure(value: unknown): UpstreamFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const kind: unknown = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  if (!isKind(kind))
    return undefined;
  const status: unknown = Object.getOwnPropertyDescriptor(value, "status")?.value;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? { kind, status }
    : { kind };
}

export function upstreamFailureText(failure: UpstreamFailure): string {
  const safe = parseUpstreamFailure(failure);
  if (!safe) return "訂閱推論失敗";
  return reasons[safe.kind] + (safe.status === undefined ? "" : `（上游 HTTP ${safe.status}）`);
}

export function upstreamFailureDetail(failure: UpstreamFailure): string {
  const safe = parseUpstreamFailure(failure);
  if (!safe) return "訂閱推論失敗";
  return safe.status === undefined ? safe.kind : `${safe.kind}（HTTP ${safe.status}）`;
}

/** 從階段結束事件讀回代理寫入的固定類別與狀態碼。 */
export function parseUpstreamFailureDetail(detail: string): UpstreamFailure | undefined {
  const match = /^([a-z_]+)(?:（HTTP ([1-5]\d\d)）)?$/.exec(detail);
  if (!match || !isKind(match[1])) return undefined;
  return match[2] ? { kind: match[1], status: Number(match[2]) } : { kind: match[1] };
}
