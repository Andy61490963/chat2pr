import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Transform } from "node:stream";
import { z } from "zod";
import { maxCodexReserve, subscriptionQuotaHold, unknownSubscriptionQuota, type SubscriptionUsage } from "../shared/subscription-quota.js";
import {
  isRetryableUpstreamFailure,
  parseUpstreamFailure,
  upstreamFailureDetail,
  type UpstreamFailure,
} from "../shared/upstream-failure.js";
import { AppError } from "./policy.js";
import { runnerRequest } from "./runner-http.js";
import {
  subscriptionFetch,
  SubscriptionTransportError,
  SUBSCRIPTION_RESPONSES_URL,
} from "./subscription-http.js";

const UPSTREAM = SUBSCRIPTION_RESPONSES_URL;
export interface SubscriptionIdentity {
  accessToken: string;
  accountId: string;
  secrets: string[];
  models: string[];
  defaultModel: string;
  quota?: SubscriptionUsage;
}
interface Run {
  deadline: number;
  requests: number;
  inputBytes: number;
  outputTokens: number;
  revoked: boolean;
  capabilities: Set<string>;
}
interface Capability {
  failure?: UpstreamFailure;
  inferenceCompleted: boolean;
  consecutiveFailures: number;
  onRetry?: (event: { kind: "upstream_retry"; detail: string }) => void;
  recordFailure: (failure: UpstreamFailure) => void;
  runId: string;
  phaseId: string;
  phase: string;
  model: string;
  deadline: number;
  identity: SubscriptionIdentity;
  probeReservePercent?: number;
  controller?: AbortController;
  timer: NodeJS.Timeout;
}
export const subscriptionLimits = {
  requests: 128,
  consecutiveFailures: 5,
  inputBytes: 512 * 1024 * 1024,
  outputTokens: 128000,
  requestBytes: 48 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  frameBytes: 8 * 1024 * 1024,
  lifetimeMs: 30 * 60 * 1000,
};
const probeLimits = { inputTokens: 128, outputTokens: 64, deltaBytes: 256, responseBytes: 64 * 1024, timeoutMs: 45000 };
const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;
function messageHasText(item: unknown) {
  return item !== null && typeof item === "object" && "type" in item && item.type === "message"
    && "content" in item && Array.isArray(item.content)
    && item.content.some((part) => part?.type === "output_text" && hasText(part.text));
}
const ProbeInput = z.strictObject({
  model: z.string().regex(/^[\w.-]{1,80}$/).nullable(),
  reservePercent: z.number().int().min(0).max(maxCodexReserve),
});
type ProbeResult = { ok: true } | { ok: false; failure: UpstreamFailure };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class BrokerError extends AppError {
  constructor(status: number, message: string, readonly kind?: UpstreamFailure["kind"]) {
    super(status, message);
  }
}
const safeError = (status: number, message: string, kind?: UpstreamFailure["kind"]) =>
  new BrokerError(status, message, kind);
const connectionMessage = "訂閱推論連線失敗，未使用其他計費方式";
const protectedDataError = () =>
  safeError(502, "訂閱上游回應包含受保護資料，已停止傳送", "protected_data");

type PublicErrors = ReadonlyMap<string, [status: number, kind: UpstreamFailure["kind"]]>;
const credentialErrors: PublicErrors = new Map([
  ["Codex 訂閱額度已達上限", [429, "quota"]],
  ["無法確認訂閱額度，暫停新的推論", [429, "quota_unavailable"]],
  ["服務需要有效的 ChatGPT 訂閱登入，未使用 API 計費", [503, "auth"]],
  ["訂閱登入讀取或刷新失敗，請確認服務登入", [503, "auth"]],
]);
function knownError(error: unknown, messages: PublicErrors) {
  if (!(error instanceof AppError)) return undefined;
  const { message, statusCode } = error;
  const rule = messages.get(message);
  if (rule && statusCode === rule[0]) return safeError(rule[0], message, rule[1]);
}
const subscriptionQuotaCodes = new Set([
  "usage_limit_reached",
  "rate_limit_exceeded",
]);
type LocalTool = {
  type: "function" | "custom";
  name: string;
  namespace?: string;
};
function localTools(
  value: unknown,
  namespace?: string,
  depth = 0,
): LocalTool[] {
  if (!Array.isArray(value) || value.length > 256 || depth > 4)
    throw safeError(403, "訂閱代理工具宣告無效", "invalid_tools");
  const result: LocalTool[] = [];
  for (const tool of value) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,200}$/.test(tool.name)
    )
      throw safeError(403, "訂閱代理不允許遠端或無名工具", "tool_denied");
    if (tool.type === "namespace") {
      result.push(
        ...localTools(
          tool.tools,
          namespace ? `${namespace}.${tool.name}` : tool.name,
          depth + 1,
        ),
      );
    } else if (tool.type === "function" || tool.type === "custom") {
      result.push({ type: tool.type, name: tool.name, namespace });
    } else throw safeError(403, "訂閱代理不允許遠端工具", "tool_denied");
    if (result.length > 256) throw safeError(403, "訂閱代理工具宣告超過限制", "tool_limit");
  }
  return result;
}
async function interruptible<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw safeError(408, "訂閱階段已取消或超過期限");
  let abort!: () => void;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(safeError(408, "訂閱階段已取消或超過期限"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function frameData(frame: string) {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}
// 截斷的 JSON 不能整筆解析，但已收到的字串仍要和完整事件的同名欄位一起檢查。
function visitPartialStrings(data: string, visit: (value: string, key: string) => void) {
  // 物件等待下一個欄名；陣列裡的字串沿用陣列所屬的欄名，與完整事件相同。
  const parents: (string | undefined)[] = [];
  let key: string | undefined = "";
  for (let i = 0; i < data.length; i++) {
    switch (data[i]) {
      case "{":
        key = undefined;
        parents.push(key);
        break;
      case "[":
        parents.push(key);
        break;
      case "}":
      case "]":
        parents.pop();
        break;
      case ",":
        key = parents.at(-1);
        break;
      case '"': {
        const start = i + 1;
        let end = start;
        for (i = start; i < data.length && data[i] !== '"'; i++) {
          if (data[i] === "\\") {
            i += data[i + 1] === "u" ? 5 : 1;
            if (i >= data.length) break;
          }
          end = i + 1;
        }
        let value: string;
        try {
          value = JSON.parse(`"${data.slice(start, end)}"`);
        } catch {
          return;
        }
        if (key === undefined) key = value;
        else visit(value, key);
        break;
      }
    }
  }
}
function containsCredential(events: unknown[], secrets: Set<string>, tail = "") {
  const lanes = new Map<string, string[]>();
  function visit(value: unknown, key = "") {
    if (typeof value === "string") {
      const lane = lanes.get(key) ?? [];
      lane.push(value);
      lanes.set(key, lane);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) visit(item, name);
  }
  events.forEach((event) => visit(event));
  if (tail) {
    const data = frameData(tail);
    try {
      visit(JSON.parse(data));
    } catch {
      visitPartialStrings(data, visit);
    }
  }
  const serialized = JSON.stringify(events);
  // 完整回應及同一文字欄位的 delta 都檢查，避免主 token 分成多個 SSE 事件。
  return [...secrets]
    .filter((secret) => secret.length >= 8)
    .some(
      (secret) =>
        serialized.includes(secret) || tail.includes(secret) ||
        [...lanes.values()].some((parts) => parts.join("").includes(secret)),
    );
}

/** 主憑證只存在可信主機；工作程式只能使用當次階段的有限推論能力。 */
export class SubscriptionBroker {
  private readonly runs = new Map<string, Run>();
  private readonly capabilities = new Map<string, Capability>();
  private readonly issuing = new Map<
    string,
    { runId: string; controller: AbortController; timer: NodeJS.Timeout }
  >();
  private readonly incoming = new WeakMap<
    FastifyRequest,
    {
      cap: Capability;
      run: Run;
      controller: AbortController;
      received: number;
      successful: boolean;
      previousFailure?: UpstreamFailure;
      cleanup: () => void;
    }
  >();
  constructor(
    private readonly options: {
      credentials: (refresh: boolean) => Promise<SubscriptionIdentity>;
      upstreamFetch?: typeof fetch;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async credentials(refresh: boolean, probeReservePercent?: number) {
    let identity: SubscriptionIdentity;
    try {
      identity = await this.options.credentials(refresh);
    } catch (error) {
      const known = knownError(error, credentialErrors);
      if (known) throw known;
      throw refresh
        ? safeError(502, connectionMessage, "auth")
        : safeError(503, "訂閱登入讀取失敗，未使用其他計費方式", "auth");
    }
    if (probeReservePercent !== undefined) {
      const hold = subscriptionQuotaHold(identity.quota ?? { allowed: null }, probeReservePercent);
      if (hold) throw safeError(429, hold, hold === unknownSubscriptionQuota ? "quota_unavailable" : "quota");
    }
    return identity;
  }
  async issue(input: {
    runId: string;
    phase: string;
    model?: string;
    deadline: number;
    onRetry?: Capability["onRetry"];
  }, probeReservePercent?: number) {
    if (
      !/^[a-f0-9-]{36}$/.test(input.runId) ||
      !["triage", "code", "review"].includes(input.phase)
    )
      throw safeError(400, "訂閱階段識別錯誤", "invalid_request");
    const started = this.now();
    const deadline = Math.min(
      input.deadline,
      started + subscriptionLimits.lifetimeMs,
    );
    if (!Number.isFinite(deadline) || deadline <= started)
      throw safeError(408, "訂閱階段已超過期限", "phase_deadline");
    for (const [id, run] of this.runs)
      if (
        run.deadline + subscriptionLimits.lifetimeMs < started &&
        !run.capabilities.size
      )
        this.runs.delete(id);
    if (!this.runs.has(input.runId) && this.runs.size >= 256)
      throw safeError(429, "訂閱工作記錄已達上限", "usage_limit");
    const run = this.runs.get(input.runId) ?? {
      deadline,
      requests: 0,
      inputBytes: 0,
      outputTokens: 0,
      revoked: false,
      capabilities: new Set<string>(),
    };
    this.runs.set(input.runId, run);
    run.deadline = Math.min(run.deadline, deadline);
    if (run.revoked || run.deadline <= started || run.capabilities.size)
      throw safeError(409, "訂閱工作已取消、逾時或已有進行中的階段",
        run.revoked ? "phase_cancelled" : run.deadline <= started ? "phase_deadline" : "concurrent_request");
    // 在等待登入刷新時也先保留此 run，避免重複 issue 越過階段鎖。
    const token = randomBytes(32).toString("hex"),
      key = digest(token);
    run.capabilities.add(key);
    const controller = new AbortController();
    const timer = setTimeout(
      () => this.revokeRun(run, { kind: "phase_deadline" }),
      Math.max(1, run.deadline - this.now()),
    );
    timer.unref();
    this.issuing.set(key, { runId: input.runId, controller, timer });
    try {
      const identity = await interruptible(
        this.credentials(false, probeReservePercent),
        controller.signal,
      );
      const model = input.model || identity.defaultModel;
      if (!identity.accessToken || !identity.accountId)
        throw safeError(403, "訂閱登入或指定模型不可用", "auth");
      if (!identity.models.includes(model))
        throw safeError(403, "訂閱登入或指定模型不可用", "model_denied");
      if (run.revoked || run.deadline <= this.now())
        throw safeError(408, "訂閱階段已取消或超過期限");
      const phaseId = randomUUID();
      this.issuing.delete(key);
      const cap: Capability = {
        runId: input.runId,
        phaseId,
        phase: input.phase,
        model,
        deadline: run.deadline,
        identity,
        probeReservePercent,
        timer,
        consecutiveFailures: 0,
        inferenceCompleted: false,
        onRetry: input.onRetry,
        recordFailure(value) {
          // 並行請求被拒時，進行中的原請求仍可能回報真正的失敗原因。
          if (!this.failure || this.failure.kind === "concurrent_request") this.failure = value;
        },
      };
      this.capabilities.set(key, cap);
      return {
        token,
        model,
        basePath: `/v1/${input.runId}/${phaseId}`,
        failure: (): UpstreamFailure | undefined => cap.failure && { ...cap.failure },
        inferenceCompleted: () => cap.inferenceCompleted && !cap.failure,
        revoke: () => this.revokePhase(key),
      };
    } catch (error) {
      clearTimeout(timer);
      this.issuing.delete(key);
      run.capabilities.delete(key);
      if (error instanceof BrokerError) {
        if (error.statusCode === 408 && !error.kind)
          throw safeError(408, error.message, run.revoked ? "phase_cancelled" : "phase_deadline");
        throw error;
      }
      throw safeError(503, "訂閱登入讀取失敗，未使用其他計費方式", "auth");
    }
  }
  private revokePhase(key: string, reason?: UpstreamFailure) {
    const issuing = this.issuing.get(key);
    if (issuing) {
      clearTimeout(issuing.timer);
      issuing.controller.abort();
      this.runs.get(issuing.runId)?.capabilities.delete(key);
      this.issuing.delete(key);
    }
    const cap = this.capabilities.get(key);
    if (!cap) return;
    clearTimeout(cap.timer);
    if (reason) cap.failure = reason;
    else if (cap.controller) cap.recordFailure({ kind: "phase_cancelled" });
    cap.controller?.abort();
    this.runs.get(cap.runId)?.capabilities.delete(key);
    this.capabilities.delete(key);
  }
  private revokeRun(run: Run, reason?: UpstreamFailure) {
    run.revoked = true;
    for (const key of [...run.capabilities]) this.revokePhase(key, reason);
  }
  revoke(runId: string) {
    const run = this.runs.get(runId);
    if (run) this.revokeRun(run, { kind: "phase_cancelled" });
  }
  close() {
    for (const runId of this.runs.keys()) this.revoke(runId);
  }
  usage(runId: string) {
    const run = this.runs.get(runId);
    return run
      ? {
          requests: run.requests,
          inputBytes: run.inputBytes,
          outputTokens: run.outputTokens,
          revoked: run.revoked,
        }
      : undefined;
  }
  registerRunnerProbe(runner: FastifyInstance, brokerPort: number) {
    let active = false;
    runner.post("/codex/inference-probe", { bodyLimit: 512 }, async (req): Promise<ProbeResult> => {
      const input = ProbeInput.safeParse(req.body);
      if (!input.success) throw safeError(400, "請提供有效的訂閱模型與個人保留比例");
      if (active) return { ok: false, failure: { kind: "concurrent_request" } };
      active = true;
      try {
        return await this.probe(brokerPort, input.data);
      } finally {
        active = false;
      }
    });
  }
  private async probe(brokerPort: number, input: z.infer<typeof ProbeInput>): Promise<ProbeResult> {
    const runId = randomUUID();
    const deadline = this.now() + probeLimits.timeoutMs;
    let lease: Awaited<ReturnType<SubscriptionBroker["issue"]>> | undefined;
    try {
      lease = await this.issue({ runId, phase: "code", model: input.model ?? undefined, deadline }, input.reservePercent);
      const response = await runnerRequest(`http://127.0.0.1:${brokerPort}${lease.basePath}/responses`, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${lease.token}` },
        body: JSON.stringify({
          model: lease.model, store: false, stream: true, instructions: "只輸出數字 1。",
          reasoning: { effort: "low" },
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "1" }] }],
        }),
        timeoutMs: Math.max(1, deadline - this.now()),
        maxResponseBytes: probeLimits.responseBytes,
      });
      const failure = lease.failure();
      if (failure) return { ok: false, failure };
      if (response.status === 200 && lease.inferenceCompleted()) return { ok: true };
      return { ok: false, failure: { kind: "connection" } };
    } catch (error) {
      const kind = this.now() >= deadline || (error instanceof Error && error.name === "TimeoutError")
        ? "phase_deadline"
        : error instanceof BrokerError ? error.kind ?? (error.statusCode === 408 ? "phase_cancelled" : "connection") : "connection";
      return { ok: false, failure: lease?.failure() ?? { kind } };
    } finally {
      this.revoke(runId);
      this.runs.delete(runId);
    }
  }
  register(app: FastifyInstance) {
    app.post<{ Params: { runId: string; phaseId: string } }>(
      "/v1/:runId/:phaseId/responses",
      {
        bodyLimit: subscriptionLimits.requestBytes,
        onRequest: async (req, reply) => {
          const auth = req.headers.authorization ?? "";
          const key = /^Bearer [a-f0-9]{64}$/.test(auth)
            ? digest(auth.slice(7))
            : "";
          const cap = this.capabilities.get(key),
            run = cap && this.runs.get(cap.runId);
          if (
            !cap ||
            !run ||
            cap.runId !== req.params.runId ||
            cap.phaseId !== req.params.phaseId ||
            run.revoked
          )
            throw safeError(403, "訂閱階段授權已失效");
          if (cap.deadline <= this.now()) {
            this.revokeRun(run, { kind: "phase_deadline" });
            throw safeError(403, "訂閱階段授權已失效");
          }
          if (cap.controller) {
            cap.recordFailure({ kind: "concurrent_request" });
            throw safeError(429, "同一訂閱階段已有進行中的呼叫");
          }
          if (
            run.requests >= subscriptionLimits.requests ||
            run.inputBytes >= subscriptionLimits.inputBytes ||
            run.outputTokens >= subscriptionLimits.outputTokens
          ) {
            this.revokeRun(run, { kind: "usage_limit" });
            throw safeError(429, "訂閱工作已達應用程式用量上限");
          }
          run.requests++;
          const controller = new AbortController();
          cap.controller = controller;
          const abort = () => controller.abort();
          const closeBody = () => {
            if (!req.raw.complete) req.raw.destroy();
          };
          controller.signal.addEventListener("abort", closeBody, {
            once: true,
          });
          req.raw.once("aborted", abort);
          reply.raw.once("close", abort);
          const incoming = {
            cap,
            run,
            controller,
            received: 0,
            successful: false,
            previousFailure: cap.failure,
            cleanup: () => {
              if (!this.incoming.delete(req)) return;
              controller.signal.removeEventListener("abort", closeBody);
              req.raw.removeListener("aborted", abort);
              reply.raw.removeListener("close", abort);
              if (cap.controller === controller) cap.controller = undefined;
              controller.abort();
              if (incoming.successful) {
                cap.failure = undefined;
                cap.consecutiveFailures = 0;
                return;
              }
              if (cap.failure && isRetryableUpstreamFailure(cap.failure)) {
                cap.consecutiveFailures++;
                if (cap.consecutiveFailures < subscriptionLimits.consecutiveFailures) return;
              }
              this.revokeRun(run);
            },
          };
          cap.failure = undefined;
          cap.inferenceCompleted = false;
          this.incoming.set(req, incoming);
        },
        preParsing: async (req, _reply, payload) => {
          const state = this.incoming.get(req)!;
          const counted = new Transform({
            transform(chunk, _encoding, done) {
              state.received += chunk.length;
              state.run.inputBytes += chunk.length;
              (
                counted as Transform & { receivedEncodedLength: number }
              ).receivedEncodedLength = state.received;
              if (state.controller.signal.aborted)
                return done(safeError(408, "訂閱階段已取消或超過期限", "phase_cancelled"));
              if (
                state.received > subscriptionLimits.requestBytes ||
                state.run.inputBytes > subscriptionLimits.inputBytes
              )
                return done(safeError(413, "訂閱請求超過用量限制", "request_limit"));
              done(null, chunk);
            },
          });
          // 解析器可能已提早拒絕本文，此時仍接住計量串流的錯誤並保留原先原因。
          counted.on("error", (error) => {
            if (error instanceof BrokerError && error.kind)
              state.cap.recordFailure({ kind: error.kind });
          });
          payload.on("error", (error) => counted.destroy(error));
          return payload.pipe(counted);
        },
        onError: async (req, _reply, error) => {
          const state = this.incoming.get(req);
          if (!state) return;
          const kind = error instanceof BrokerError && error.kind
            ? error.kind
            : error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "request_limit" : "invalid_request";
          state.cap.recordFailure({ kind });
          state.cleanup();
        },
        onResponse: async (req) => {
          this.incoming.get(req)?.cleanup();
        },
      },
      async (req, reply) => {
        const state = this.incoming.get(req)!;
        const { cap, run, controller } = state;
        const phaseError = () =>
          safeError(408, "訂閱階段已取消或超過期限",
            cap.deadline <= this.now() ? "phase_deadline" : "phase_cancelled");
        if (controller.signal.aborted || cap.deadline <= this.now())
          throw phaseError();
        const raw = req.body as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || raw.model !== cap.model)
          throw safeError(403, "不允許此訂閱模型", "model_denied");
        if (
          raw.previous_response_id ||
          raw.background ||
          !Array.isArray(raw.input) ||
          raw.stream !== true ||
          raw.store === true
        )
          throw safeError(400, "只接受不保存遠端歷史的串流推論", "invalid_request");
        const declared = raw.tools === undefined ? [] : localTools(raw.tools);
        // Codex 0.166 的 Responses-Lite 將工具宣告放在 input；所有宣告入口使用同一守門。
        for (const item of raw.input)
          if (
            item?.type === "additional_tools" ||
            item?.type === "tool_search_output"
          )
            declared.push(...localTools(item.tools));
        if (declared.length > 256)
          throw safeError(403, "訂閱代理工具宣告超過限制", "tool_limit");
        if (raw.tool_choice !== undefined) {
          const choice = raw.tool_choice as {
            type?: unknown;
            name?: unknown;
            namespace?: unknown;
          };
          const namedLocal =
            choice &&
            typeof choice === "object" &&
            ["function", "custom"].includes(String(choice.type)) &&
            typeof choice.name === "string" &&
            declared.some(
              (tool) =>
                tool.type === choice.type &&
                (tool.name === choice.name ||
                  `${tool.namespace}.${tool.name}` === choice.name) &&
                (choice.namespace === undefined ||
                  choice.namespace === tool.namespace),
            );
          if (
            !["auto", "none", "required"].includes(String(raw.tool_choice)) &&
            !namedLocal
          )
            throw safeError(403, "訂閱代理不允許指定遠端工具", "tool_choice_denied");
        }
        const body: Record<string, unknown> = {};
        for (const name of [
          "model",
          "input",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "reasoning",
          "text",
          "include",
        ])
          if (raw[name] !== undefined) body[name] = raw[name];
        body.instructions =
          typeof raw.instructions === "string"
            ? raw.instructions
            : "Follow the developer and user instructions within the configured tool permissions.";
        body.store = false;
        body.stream = true;
        body.prompt_cache_key = cap.runId;
        const probe = cap.probeReservePercent !== undefined;
        const serialized = JSON.stringify(body);
        let completedTokens: number | undefined;
        let outputText = false;
        let probeDeltaBytes = 0;
        let tail = "";
        const events: unknown[] = [];
        let upstreamStatus: number | undefined;
        let fallbackKind: UpstreamFailure["kind"] | undefined;
        const secrets = new Set([
          cap.identity.accessToken,
          cap.identity.accountId,
          ...cap.identity.secrets,
        ]);
        try {
          let response: Response | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (controller.signal.aborted || cap.deadline <= this.now())
              throw phaseError();
            if (attempt === 0 && state.previousFailure)
              cap.onRetry?.({
                kind: "upstream_retry",
                detail: `上游暫時失敗，已讓 Codex 重試（第 ${cap.consecutiveFailures} 次）：${upstreamFailureDetail(state.previousFailure)}`,
              });
            upstreamStatus = undefined;
            fallbackKind = "connection";
            response = await (this.options.upstreamFetch ?? subscriptionFetch)(
              UPSTREAM,
              {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: {
                  Authorization: `Bearer ${cap.identity.accessToken}`,
                  "ChatGPT-Account-Id": cap.identity.accountId,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  originator: "codex_cli_rs",
                },
                body: serialized,
              },
            ).catch((error: unknown) => {
              if (!this.options.upstreamFetch && error instanceof SubscriptionTransportError) {
                upstreamStatus = error.upstreamStatus;
                throw safeError(error.statusCode, error.message, error.kind);
              }
              throw safeError(502, connectionMessage, "connection");
            });
            upstreamStatus = response.status;
            if (response.status !== 401 || attempt) break;
            fallbackKind = "auth";
            await response.body?.cancel();
            const previous = cap.identity.accessToken;
            cap.identity = await interruptible(
              this.credentials(true, cap.probeReservePercent),
              controller.signal,
            );
            for (const secret of [
              cap.identity.accessToken,
              cap.identity.accountId,
              ...cap.identity.secrets,
            ])
              secrets.add(secret);
            if (
              !cap.identity.models.includes(cap.model) ||
              cap.identity.accessToken === previous
            )
              throw safeError(401, "訂閱登入已失效，請重新登入", "auth");
          }
          if (!response?.ok || !response.body) {
            const status =
              response?.status === 429
                ? 429
                : response?.status === 401
                  ? 401
                  : 502;
            if (status === 429) fallbackKind = "quota";
            else if (status === 401) fallbackKind = "auth";
            else if (upstreamStatus !== undefined && upstreamStatus >= 300 && upstreamStatus < 400)
              fallbackKind = "redirect";
            else fallbackKind = response?.ok ? "missing_body" : "upstream_http";
            await response?.body?.cancel();
            throw safeError(
              status,
              status === 429
                ? "Codex 訂閱額度已達上限"
                : "訂閱上游回應失敗，未使用其他計費方式",
              fallbackKind,
            );
          }
          const contentType = response.headers.get("content-type");
          if (contentType && !contentType.includes("text/event-stream")) {
            fallbackKind = "invalid_stream";
            await response.body.cancel();
            throw safeError(502, "訂閱上游未回傳有效串流", "invalid_stream");
          }
          let bytes = 0;
          const decoder = new TextDecoder();
          fallbackKind = "stream_interrupted";
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (controller.signal.aborted || cap.deadline <= this.now())
              throw phaseError();
            bytes += chunk.byteLength;
            if (bytes > (probe ? probeLimits.responseBytes : subscriptionLimits.responseBytes))
              throw safeError(429, "訂閱回應超過用量上限", "response_limit");
            tail += decoder.decode(chunk, { stream: true });
            const frames = tail.split(/\r?\n\r?\n/);
            tail = frames.pop() ?? "";
            if (Buffer.byteLength(tail) > subscriptionLimits.frameBytes)
              throw safeError(502, "訂閱回應事件超過限制", "frame_limit");
            for (const frame of frames) {
              const data = frameData(frame);
              if (!data || data === "[DONE]") continue;
              if (Buffer.byteLength(data) > subscriptionLimits.frameBytes)
                throw safeError(502, "訂閱回應事件超過限制", "frame_limit");
              let event;
              try {
                event = JSON.parse(data);
              } catch {
                throw safeError(502, connectionMessage, "invalid_event");
              }
              if (event === null) throw safeError(502, connectionMessage, "invalid_event");
              if (typeof event.type !== "string")
                throw safeError(502, "訂閱推論串流回報錯誤", "invalid_event");
              if (
                event.type === "error" ||
                event.type === "response.failed" ||
                event.response?.error ||
                event.error
              ) {
                // 僅信任真正錯誤事件的既知結構化代碼；模型文字與 message 不參與額度判定。
                const quota =
                  ["error", "response.failed"].includes(event.type) &&
                  [event, event.error, event.response?.error].some(
                    (error) =>
                      error &&
                      typeof error === "object" &&
                      [error.code, error.type].some((code) =>
                        subscriptionQuotaCodes.has(code),
                      ),
                  );
                throw safeError(
                  quota ? 429 : 502,
                  quota ? "Codex 訂閱額度已達上限" : "訂閱推論串流回報錯誤",
                  quota ? "quota" : "stream_error",
                );
              }
              const truncatedProbe = probe && event.type === "response.incomplete" && event.response?.incomplete_details?.reason === "max_output_tokens";
              if (truncatedProbe && !event.response?.usage)
                throw safeError(429, "訂閱探測已達輸出上限", "output_limit");
              if (probe && event.type.endsWith(".delta") && typeof event.delta === "string") {
                probeDeltaBytes += Buffer.byteLength(event.delta);
                if (probeDeltaBytes >= probeLimits.deltaBytes) {
                  cap.recordFailure({ kind: "output_limit", status: upstreamStatus });
                  controller.abort();
                  throw safeError(429, "訂閱探測已達串流文字上限", "output_limit");
                }
              }
              if (!outputText)
                outputText = (event.type === "response.output_text.delta" && hasText(event.delta))
                  || (event.type === "response.output_text.done" && hasText(event.text))
                  || (event.type === "response.output_item.done" && messageHasText(event.item))
                  || (event.type === "response.completed" && Array.isArray(event.response?.output) && event.response.output.some(messageHasText));
              if (event.type === "response.completed" || event.type === "response.incomplete") {
                const u = event.response?.usage;
                if (
                  !u ||
                  !Number.isSafeInteger(u.output_tokens) ||
                  u.output_tokens < (probe && event.type === "response.completed" ? 1 : 0) ||
                  !Number.isSafeInteger(u.input_tokens) ||
                  u.input_tokens < 0 ||
                  (u.input_tokens_details?.cached_tokens !== undefined &&
                    (!Number.isSafeInteger(
                      u.input_tokens_details.cached_tokens,
                    ) ||
                      u.input_tokens_details.cached_tokens < 0 ||
                      u.input_tokens_details.cached_tokens > u.input_tokens))
                )
                  throw safeError(502, "訂閱回應缺少有效用量", "invalid_usage");
                if (completedTokens !== undefined) throw safeError(502, "訂閱回應重複完成", "duplicate_completion");
                run.outputTokens += u.output_tokens;
                if (probe && u.input_tokens > probeLimits.inputTokens)
                  throw safeError(429, "訂閱探測已達輸入用量上限", "usage_limit");
                if (truncatedProbe || run.outputTokens > (probe ? probeLimits.outputTokens : subscriptionLimits.outputTokens))
                  throw safeError(429, "訂閱工作已達應用程式用量上限", "output_limit");
                if (event.type === "response.incomplete")
                  throw safeError(502, "訂閱推論串流回報錯誤", "stream_error");
                completedTokens = u.output_tokens;
              }
              events.push(event);
            }
          }
          if (completedTokens === undefined || tail.trim())
            throw safeError(502, "訂閱串流在完成前中斷", "stream_interrupted");
          if (
            controller.signal.aborted ||
            reply.raw.destroyed ||
            cap.deadline <= this.now()
          )
            throw phaseError();
          if (containsCredential(events, secrets))
            throw protectedDataError();
          if (probe && !outputText)
            throw safeError(502, "訂閱探測沒有收到輸出文字", "missing_body");
          fallbackKind = undefined;
          // 有界緩衝至完成後才釋出，避免錯誤、半個 token 或偽完成事件先到工作容器。
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          });
          for (const event of events)
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          state.successful = true;
          reply.raw.end();
          cap.inferenceCompleted = outputText && completedTokens > 0;
        } catch (error) {
          let publicError =
            error instanceof BrokerError
              ? error
              : safeError(502, connectionMessage, fallbackKind);
          if (publicError.kind === "stream_interrupted" && containsCredential(events, secrets, tail))
            publicError = protectedDataError();
          const failure = parseUpstreamFailure({ kind: publicError.kind, status: upstreamStatus });
          if (controller.signal.aborted || cap.deadline <= this.now())
            cap.recordFailure({ kind: cap.deadline <= this.now() ? "phase_deadline" : "phase_cancelled" });
          else if (failure) cap.recordFailure(failure);
          throw publicError;
        } finally {
          state.cleanup();
        }
      },
    );
  }
}
