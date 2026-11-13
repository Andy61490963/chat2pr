import { AppError } from "./policy.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** 僅供 GitHub JSON／認證 API；原始碼封存下載仍使用獨立串流下載器。 */
export function createGitHubFetch({
  timeoutMs = 30000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}): typeof fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(new DOMException("GitHub API 請求逾時", "TimeoutError")),
      timeoutMs,
    );
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });
    const request = async () => {
      signal.throwIfAborted();
      const response = await globalThis.fetch(input, { ...init, signal });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxResponseBytes) {
              const error = new AppError(413, "GitHub API 回應超過允許大小");
              deadline.abort(error);
              throw error;
            }
            parts.push(chunk.value);
          }
        } finally {
          if (signal.aborted) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      // Octokit 會吞掉 response.text() 的例外。先在同一截止時間讀完，
      // 才能讓慢速／中斷本文明確失敗，避免得到成功狀態但資料為空字串。
      const buffered = new Response(size ? bytes.buffer : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperties(buffered, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return buffered;
    };
    try {
      return await Promise.race([request(), aborted]);
    } finally {
      clearTimeout(timer);
      if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
      if (signal.aborted) void reader?.cancel().catch(() => {});
    }
  };
}

export const githubHttpFetch = createGitHubFetch();
