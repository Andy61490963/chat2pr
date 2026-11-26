import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Transform } from "node:stream";
import { AppError } from "./policy.js";
import {
  subscriptionFetch,
  SubscriptionRedirectError,
  SUBSCRIPTION_RESPONSES_URL,
} from "./subscription-http.js";
import {
  httpFailureKind,
  upstreamErrorCodes,
  type UpstreamFailure,
  type UpstreamFailureKind,
} from "../shared/upstream-failure.js";

const UPSTREAM = SUBSCRIPTION_RESPONSES_URL;
export interface SubscriptionIdentity {
  accessToken: string;
  accountId: string;
  secrets: string[];
  models: string[];
  defaultModel: string;
}
interface Run {
  deadline: number;
  requests: number;
  inputBytes: number;
  outputTokens: number;
  revoked: boolean;
  capabilities: Set<string>;
  /** 最近一次上游失敗的固定類別；只有列舉值與狀態碼，不含上游內容。 */
  upstreamFailure?: UpstreamFailure;
}
interface Capability {
  upstreamObservedAt?: number;
  runId: string;
  phaseId: string;
  phase: string;
  model: string;
  deadline: number;
  identity: SubscriptionIdentity;
  controller?: AbortController;
  timer: NodeJS.Timeout;
}
export const subscriptionLimits = {
  requests: 128,
  inputBytes: 512 * 1024 * 1024,
  outputTokens: 128000,
  requestBytes: 48 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  frameBytes: 8 * 1024 * 1024,
  lifetimeMs: 30 * 60 * 1000,
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const safeError = (status: number, message: string) =>
  new AppError(status, message);
/** 上游造成的失敗：訊息仍是固定安全文字，另帶可記錄的類別。 */
class UpstreamError extends AppError {
  constructor(
    status: number,
    message: string,
    readonly failure: UpstreamFailure,
  ) {
    super(status, message);
  }
}
const upstreamError = (
  status: number,
  message: string,
  kind: UpstreamFailureKind,
  upstreamStatus?: number,
) =>
  new UpstreamError(status, message, {
    kind,
    ...(upstreamStatus ? { status: upstreamStatus } : {}),
  });
/** 失敗事件的類別：只認白名單內完整的 code／type 字串，模型文字與 message 不參與。 */
function eventFailureKind(event: {
  error?: unknown;
  response?: { error?: unknown };
}): UpstreamFailureKind {
  for (const error of [event, event.error, event.response?.error])
    if (error && typeof error === "object")
      for (const code of [
        (error as { code?: unknown }).code,
        (error as { type?: unknown }).type,
      ])
        if (typeof code === "string" && Object.hasOwn(upstreamErrorCodes, code))
          return upstreamErrorCodes[code];
  return "stream_error";
}
async function responseFailureKind(response: Response): Promise<UpstreamFailureKind> {
  const fallback = httpFailureKind(response.status);
  if (![400, 404, 422].includes(response.status) || !response.body ||
      !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    return fallback;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) return fallback;
      chunks.push(value);
    }
    const kind = eventFailureKind(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return kind === "model_unavailable" || kind === "context_too_long" ? kind : fallback;
  } catch {
    return fallback;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
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
    throw safeError(403, "訂閱代理工具宣告無效");
  const result: LocalTool[] = [];
  for (const tool of value) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,200}$/.test(tool.name)
    )
      throw safeError(403, "訂閱代理不允許遠端或無名工具");
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
    } else throw safeError(403, "訂閱代理不允許遠端工具");
    if (result.length > 256) throw safeError(403, "訂閱代理工具宣告超過限制");
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
function containsCredential(events: unknown[], secrets: Set<string>) {
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
  const serialized = JSON.stringify(events);
  // 完整回應及同一文字欄位的 delta 都檢查，避免主 token 分成多個 SSE 事件。
  return [...secrets]
    .filter((secret) => secret.length >= 8)
    .some(
      (secret) =>
        serialized.includes(secret) ||
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
  async issue(input: {
    runId: string;
    phase: string;
    model?: string;
    deadline: number;
  }) {
    if (
      !/^[a-f0-9-]{36}$/.test(input.runId) ||
      !["triage", "code", "review"].includes(input.phase)
    )
      throw safeError(400, "訂閱階段識別錯誤");
    const started = this.now();
    const deadline = Math.min(
      input.deadline,
      started + subscriptionLimits.lifetimeMs,
    );
    if (!Number.isFinite(deadline) || deadline <= started)
      throw safeError(408, "訂閱階段已超過期限");
    for (const [id, run] of this.runs)
      if (
        run.deadline + subscriptionLimits.lifetimeMs < started &&
        !run.capabilities.size
      )
        this.runs.delete(id);
    if (!this.runs.has(input.runId) && this.runs.size >= 256)
      throw safeError(429, "訂閱工作記錄已達上限");
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
      throw safeError(409, "訂閱工作已取消、逾時或已有進行中的階段");
    // 在等待登入刷新時也先保留此 run，避免重複 issue 越過階段鎖。
    const token = randomBytes(32).toString("hex"),
      key = digest(token);
    run.capabilities.add(key);
    const controller = new AbortController();
    const timer = setTimeout(
      () => this.revokePhase(key),
      Math.max(1, run.deadline - this.now()),
    );
    timer.unref();
    this.issuing.set(key, { runId: input.runId, controller, timer });
    try {
      const identity = await interruptible(
        this.options.credentials(false),
        controller.signal,
      );
      const model = input.model || identity.defaultModel;
      if (
        !identity.accessToken ||
        !identity.accountId ||
        !identity.models.includes(model)
      )
        throw safeError(403, "訂閱登入或指定模型不可用");
      if (run.revoked || run.deadline <= this.now())
        throw safeError(408, "訂閱階段已取消或超過期限");
      const phaseId = randomUUID();
      this.issuing.delete(key);
      const capability: Capability = {
        runId: input.runId,
        phaseId,
        phase: input.phase,
        model,
        deadline: run.deadline,
        identity,
        timer,
      };
      this.capabilities.set(key, capability);
      return {
        token,
        model,
        basePath: `/v1/${input.runId}/${phaseId}`,
        outcome: () => {
          const failure = this.upstreamFailure(input.runId);
          const upstreamObservedAt = capability.upstreamObservedAt;
          if (upstreamObservedAt === undefined) return {};
          return failure ? { upstreamFailure: failure, upstreamObservedAt } : { upstreamSucceeded: true as const, upstreamObservedAt };
        },
        revoke: () => this.revokePhase(key),
      };
    } catch (error) {
      clearTimeout(timer);
      this.issuing.delete(key);
      run.capabilities.delete(key);
      if (error instanceof AppError) throw error;
      throw safeError(503, "訂閱登入讀取失敗，未使用其他計費方式");
    }
  }
  private revokePhase(key: string) {
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
    cap.controller?.abort();
    this.runs.get(cap.runId)?.capabilities.delete(key);
    this.capabilities.delete(key);
  }
  revoke(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.revoked = true;
    for (const key of [...run.capabilities]) this.revokePhase(key);
  }
  close() {
    for (const runId of this.runs.keys()) this.revoke(runId);
  }
  /** 這次工作最近一次上游失敗的類別與狀態碼（只有固定列舉值與數字）。 */
  upstreamFailure(runId: string): UpstreamFailure | undefined {
    return this.runs.get(runId)?.upstreamFailure;
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
            run.revoked ||
            cap.deadline <= this.now()
          )
            throw safeError(403, "訂閱階段授權已失效");
          if (cap.controller)
            throw safeError(429, "同一訂閱階段已有進行中的呼叫");
          if (
            run.requests >= subscriptionLimits.requests ||
            run.inputBytes >= subscriptionLimits.inputBytes ||
            run.outputTokens >= subscriptionLimits.outputTokens
          )
            throw safeError(429, "訂閱工作已達應用程式用量上限");
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
            cleanup: () => {
              controller.signal.removeEventListener("abort", closeBody);
              req.raw.removeListener("aborted", abort);
              reply.raw.removeListener("close", abort);
              if (cap.controller === controller) cap.controller = undefined;
              controller.abort();
              this.incoming.delete(req);
              if (!incoming.successful) this.revoke(cap.runId);
            },
          };
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
                return done(safeError(408, "訂閱階段已取消或超過期限"));
              if (
                state.received > subscriptionLimits.requestBytes ||
                state.run.inputBytes > subscriptionLimits.inputBytes
              )
                return done(safeError(413, "訂閱請求超過用量限制"));
              done(null, chunk);
            },
          });
          payload.on("error", (error) => counted.destroy(error));
          return payload.pipe(counted);
        },
        onError: async (req) => {
          this.incoming.get(req)?.cleanup();
        },
        onResponse: async (req) => {
          this.incoming.get(req)?.cleanup();
        },
      },
      async (req, reply) => {
        const state = this.incoming.get(req)!;
        const { cap, run, controller } = state;
        if (controller.signal.aborted || cap.deadline <= this.now())
          throw safeError(408, "訂閱階段已取消或超過期限");
        const raw = req.body as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || raw.model !== cap.model)
          throw safeError(403, "不允許此訂閱模型");
        if (
          raw.previous_response_id ||
          raw.background ||
          !Array.isArray(raw.input) ||
          raw.stream !== true ||
          raw.store === true
        )
          throw safeError(400, "只接受不保存遠端歷史的串流推論");
        const declared = raw.tools === undefined ? [] : localTools(raw.tools);
        // Codex 0.166 的 Responses-Lite 將工具宣告放在 input；所有宣告入口使用同一守門。
        for (const item of raw.input)
          if (
            item?.type === "additional_tools" ||
            item?.type === "tool_search_output"
          )
            declared.push(...localTools(item.tools));
        if (declared.length > 256)
          throw safeError(403, "訂閱代理工具宣告超過限制");
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
            throw safeError(403, "訂閱代理不允許指定遠端工具");
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
        const serialized = JSON.stringify(body);
        let complete = false;
        const secrets = new Set([
          cap.identity.accessToken,
          cap.identity.accountId,
          ...cap.identity.secrets,
        ]);
        try {
          let response: Response | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (controller.signal.aborted || cap.deadline <= this.now())
              throw safeError(408, "訂閱階段已取消或超過期限");
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
              if (error instanceof SubscriptionRedirectError)
                throw upstreamError(502, "訂閱上游不接受重新導向", "rejected", error.upstreamStatus);
              // 傳輸層的錯誤可能帶上游或憑證內容，只留類別。
              throw upstreamError(
                502,
                "訂閱推論連線失敗，未使用其他計費方式",
                "connection",
              );
            });
            if (response.status !== 401 || attempt) break;
            const previous = cap.identity.accessToken;
            try {
              await response.body?.cancel();
              cap.identity = await interruptible(
                this.options.credentials(true),
                controller.signal,
              );
            } catch (error) {
              if (error instanceof AppError && error.statusCode === 429)
                throw upstreamError(429, "訂閱額度檢查未通過，已暫停推論", "quota", 401);
              throw upstreamError(401, "訂閱登入刷新失敗，請確認服務登入", "auth", 401);
            }
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
              throw upstreamError(401, "訂閱登入已失效，請重新登入", "auth", 401);
          }
          if (!response)
            throw upstreamError(502, "訂閱推論連線失敗，未使用其他計費方式", "connection");
          const upstreamStatus = response.status;
          if (!response.ok) {
            const status =
              upstreamStatus === 429 ? 429 : upstreamStatus === 401 ? 401 : 502;
            throw upstreamError(
              status,
              status === 429
                ? "Codex 訂閱額度已達上限"
                : "訂閱上游回應失敗，未使用其他計費方式",
              await responseFailureKind(response),
              upstreamStatus,
            );
          }
          const contentType = response.headers.get("content-type");
          if (!response.body || (contentType && !contentType.includes("text/event-stream"))) {
            await response.body?.cancel();
            throw upstreamError(
              502,
              "訂閱上游未回傳有效串流",
              "invalid_response",
              upstreamStatus,
            );
          }
          let tail = "",
            bytes = 0;
          const events: unknown[] = [];
          const decoder = new TextDecoder();
          const invalid = (message: string) =>
            upstreamError(502, message, "invalid_response", upstreamStatus);
          // 讀串流途中斷線（socket 重設等）的原始錯誤可能帶上游內容，只留類別。
          const chunks = (async function* (
            body: AsyncIterable<Uint8Array>,
          ) {
            try {
              yield* body;
            } catch (error) {
              if (error instanceof AppError) throw error;
              throw upstreamError(
                502,
                "訂閱串流在完成前中斷",
                "stream_interrupted",
                upstreamStatus,
              );
            }
          })(response.body as unknown as AsyncIterable<Uint8Array>);
          for await (const chunk of chunks) {
            if (controller.signal.aborted || cap.deadline <= this.now())
              throw safeError(408, "訂閱階段已取消或超過期限");
            bytes += chunk.byteLength;
            if (bytes > subscriptionLimits.responseBytes)
              throw safeError(429, "訂閱回應超過用量上限");
            tail += decoder.decode(chunk, { stream: true });
            const frames = tail.split(/\r?\n\r?\n/);
            tail = frames.pop() ?? "";
            if (Buffer.byteLength(tail) > subscriptionLimits.frameBytes)
              throw invalid("訂閱回應事件超過限制");
            for (const frame of frames) {
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data || data === "[DONE]") continue;
              if (Buffer.byteLength(data) > subscriptionLimits.frameBytes)
                throw invalid("訂閱回應事件超過限制");
              let event;
              try {
                event = JSON.parse(data);
              } catch {
                throw invalid("訂閱回應事件格式無效");
              }
              if (typeof event?.type !== "string")
                throw invalid("訂閱回應事件格式無效");
              if (
                event.type === "error" ||
                event.type === "response.failed" ||
                event.response?.error ||
                event.error
              ) {
                // 僅信任真正錯誤事件的既知結構化代碼；模型文字與 message 不參與類別與額度判定。
                const kind = ["error", "response.failed"].includes(event.type)
                  ? eventFailureKind(event)
                  : "stream_error";
                throw upstreamError(
                  kind === "quota" ? 429 : 502,
                  kind === "quota"
                    ? "Codex 訂閱額度已達上限"
                    : "訂閱推論串流回報錯誤",
                  kind,
                  upstreamStatus,
                );
              }
              if (event.type === "response.completed") {
                const u = event.response?.usage;
                if (
                  !u ||
                  !Number.isSafeInteger(u.output_tokens) ||
                  u.output_tokens < 0 ||
                  !Number.isSafeInteger(u.input_tokens) ||
                  u.input_tokens < 0 ||
                  (u.input_tokens_details?.cached_tokens !== undefined &&
                    (!Number.isSafeInteger(
                      u.input_tokens_details.cached_tokens,
                    ) ||
                      u.input_tokens_details.cached_tokens < 0 ||
                      u.input_tokens_details.cached_tokens > u.input_tokens))
                )
                  throw invalid("訂閱回應缺少有效用量");
                if (complete) throw invalid("訂閱回應重複完成");
                run.outputTokens += u.output_tokens;
                if (run.outputTokens > subscriptionLimits.outputTokens)
                  throw safeError(429, "訂閱工作已達應用程式用量上限");
                complete = true;
              }
              events.push(event);
            }
          }
          if (!complete || tail.trim())
            throw upstreamError(
              502,
              "訂閱串流在完成前中斷",
              "stream_interrupted",
              upstreamStatus,
            );
          if (
            controller.signal.aborted ||
            reply.raw.destroyed ||
            cap.deadline <= this.now()
          )
            throw safeError(408, "訂閱階段已取消或超過期限");
          if (containsCredential(events, secrets))
            throw safeError(502, "訂閱上游回應包含受保護資料，已停止傳送");
          // 有界緩衝至完成後才釋出，避免錯誤、半個 token 或偽完成事件先到工作容器。
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          });
          for (const event of events)
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          state.successful = true;
          cap.upstreamObservedAt = this.now();
          reply.raw.end();
        } catch (error) {
          if (controller.signal.aborted || cap.deadline <= this.now())
            throw safeError(408, "訂閱階段已取消或超過期限");
          if (error instanceof UpstreamError) {
            run.upstreamFailure = error.failure;
            cap.upstreamObservedAt = this.now();
          }
          // 原始 fetch、OAuth、JSON 錯誤及供應商本文可能包含主憑證，全部使用固定安全訊息。
          const publicError =
            error instanceof AppError
              ? error
              : safeError(502, "訂閱推論連線失敗，未使用其他計費方式");
          throw publicError;
        } finally {
          // 無完成用量的呼叫不可讓工作程式盲重試；新工作需重新取得可信服務核准。
          state.cleanup();
        }
      },
    );
  }
}
