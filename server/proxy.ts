import type { FastifyInstance } from "fastify";
import { Database } from "./db.js";
import { Budget, prices } from "./budget.js";
import { hash } from "./auth.js";
import { secrets } from "./config.js";
import { AppError } from "./policy.js";
import { setTimeout as delay } from "node:timers/promises";
export function registerProxy(
  app: FastifyInstance,
  db: Database,
  budget: Budget,
) {
  app.post(
    "/internal/proxy/v1/responses",
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (!bearer) throw new AppError(401, "缺少執行授權");
      const run = await db.one<{
        id: string;
        task_id: string;
        reservation_id: string;
        model: string;
        deadline: Date;
      }>(
        `SELECT r.id,r.task_id,r.reservation_id,r.model,r.deadline FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.token_hash=$1 AND r.completed_at IS NULL AND r.proxy_active AND r.deadline>now() AND t.status IN ('running','reviewing') AND t.version=r.version`,
        [hash(bearer)],
      );
      if (!run) throw new AppError(403, "執行授權已失效");
      const data = req.body as Record<string, unknown>;
      if (data.model !== run.model || !prices[run.model])
        throw new AppError(403, "不允許此模型");
      if (data.previous_response_id)
        throw new AppError(400, "不接受跨請求的遠端歷史");
      if (
        Array.isArray(data.tools) &&
        data.tools.some(
          (t: Record<string, unknown>) =>
            !["function", "custom"].includes(String(t.type)),
        )
      )
        throw new AppError(403, "不允許代理啟用遠端工具");
      const lock = await db.pool.connect();
      let locked = false;
      try {
        // SDK 收到完成事件後可能立刻送下一輪；上一輪記帳仍須持鎖。
        // 有界等候保持呼叫序列化，不把正常交接誤判為供應商限流。
        const waitUntil = Math.min(
          Date.now() + 2000,
          new Date(run.deadline).getTime(),
        );
        do {
          locked = (
            await lock.query(
              "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
              [`proxy:${run.id}`],
            )
          ).rows[0].locked;
          if (locked || Date.now() >= waitUntil) break;
          await delay(25);
        } while (true);
        if (!locked) throw new AppError(429, "同一執行已有進行中的 API 呼叫");
        const current = await db.one<{ ok: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.completed_at IS NULL AND r.proxy_active AND r.deadline>now() AND t.status IN ('running','reviewing') AND t.version=r.version) AS ok",
          [run.id],
        );
        if (!current.ok) throw new AppError(403, "執行授權已失效");
        await budget.allowed(run.reservation_id);
        const remaining = await db.one<{ left: number }>(
          "SELECT (amount-spent)::float AS left FROM reservations WHERE id=$1",
          [run.reservation_id],
        );
        const p = prices[run.model];
        // UTF-8 位元組數作為偏保守的輸入 token 上界，避免單次請求跨越預留額度。
        const inputUpper = Buffer.byteLength(JSON.stringify(data));
        const inputCost =
          (inputUpper * p.input * (inputUpper > 272000 ? 2 : 1)) / 1e6;
        const maxOutput = Math.min(
          16000,
          Number(data.max_output_tokens ?? 16000),
          Math.floor(
            ((remaining.left - inputCost) * 1e6) /
              (p.output * (inputUpper > 272000 ? 2 : 1)),
          ),
        );
        if (maxOutput < 256)
          throw new AppError(429, "剩餘預估額度不足以發送下一次呼叫");
        data.store = false;
        data.max_output_tokens = maxOutput;
        data.service_tier = "default";
        const key = secrets().openaiKey;
        if (!key) throw new AppError(503, "OpenAI 尚未設定");
        const abort = new AbortController();
        const timer = setTimeout(
          () => abort.abort(),
          Math.min(180000, new Date(run.deadline).getTime() - Date.now()),
        );
        const active = setInterval(() => {
          void db
            .one<{ ok: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.completed_at IS NULL AND r.proxy_active AND t.status IN ('running','reviewing') AND t.version=r.version) AS ok",
              [run.id],
            )
            .then((r) => {
              if (!r.ok) abort.abort();
            })
            .catch(() => abort.abort());
        }, 2000);
        req.raw.on("aborted", () => abort.abort());
        let settled = false,
          accepted = false;
        try {
          const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
            signal: abort.signal,
          });
          if (!response.ok) {
            // 僅記錄可辨識的錯誤代碼，不保存供應商可能回顯的提示或憑證。
            const failure = (await response.json().catch(() => ({}))) as {
              error?: { code?: string };
            };
            const code = [
              "rate_limit_exceeded",
              "slow_down",
              "insufficient_quota",
            ].includes(failure.error?.code ?? "")
              ? failure.error!.code
              : "unknown";
            const retryAfter = response.headers.get("retry-after");
            if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter))
              reply.header("Retry-After", retryAfter);
            await db.audit(
              run.task_id,
              "api_error",
              `OpenAI 回應 ${response.status}（${code}），執行 ${run.id}`,
            );
            reply.code(response.status);
            return {
              error: {
                message: `OpenAI 呼叫失敗（${response.status}，${code}）`,
                code,
              },
            };
          }
          accepted = true;
          if (!data.stream) {
            const body = (await response.json()) as {
              usage?: {
                input_tokens: number;
                input_tokens_details?: { cached_tokens: number };
                output_tokens: number;
              };
            };
            if (body.usage) {
              await budget.charge(
                run.reservation_id,
                run.model,
                body.usage.input_tokens,
                body.usage.input_tokens_details?.cached_tokens ?? 0,
                body.usage.output_tokens,
              );
              settled = true;
            }
            return body;
          }
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          let tail = "";
          const decoder = new TextDecoder();
          for await (const bytes of response.body! as unknown as AsyncIterable<Uint8Array>) {
            reply.raw.write(bytes);
            tail += decoder.decode(bytes, { stream: true });
            const frames = tail.split("\n");
            tail = frames.pop() ?? "";
            for (const frame of frames) {
              if (!frame.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(frame.slice(6));
                const u = event.response?.usage;
                if (u && !settled) {
                  await budget.charge(
                    run.reservation_id,
                    run.model,
                    u.input_tokens,
                    u.input_tokens_details?.cached_tokens ?? 0,
                    u.output_tokens,
                  );
                  settled = true;
                }
              } catch (e) {
                if (!(e instanceof SyntaxError)) throw e;
              }
            }
          }
          reply.raw.end();
        } finally {
          clearTimeout(timer);
          clearInterval(active);
          if (accepted && !settled)
            await budget.charge(
              run.reservation_id,
              run.model,
              inputUpper,
              0,
              maxOutput,
            );
          if (reply.raw.headersSent && !reply.raw.writableEnded)
            reply.raw.end();
        }
      } catch (error) {
        if (reply.raw.headersSent) {
          // hijack 後再拋出例外會由 Fastify 直接記錄原始錯誤與堆疊，繞過
          // 一般錯誤遮蔽。串流已結束且已保守記帳，只保存固定安全原因。
          await db.audit(
            run.task_id,
            "api_stream_error",
            `OpenAI 串流在完成前中斷，執行 ${run.id}；已結束連線並保守估算用量`,
          );
          return;
        }
        if (error instanceof AppError)
          await db.audit(
            run.task_id,
            "proxy_rejected",
            `代理拒絕呼叫：${error.message}，執行 ${run.id}`,
          );
        throw error;
      } finally {
        if (locked)
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
            `proxy:${run.id}`,
          ]);
        lock.release();
      }
    },
  );
}
