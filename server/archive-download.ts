import { AppError } from "./policy.js";

export async function downloadArchive(
  url: string,
  token: string,
  request: typeof fetch = fetch,
) {
  const abort = new AbortController();
  const total = setTimeout(
    () => abort.abort(new Error("封存檔下載超過 30 分鐘")),
    30 * 60_000,
  );
  let idle = setTimeout(
    () => abort.abort(new Error("封存檔連線逾時（60 秒）")),
    60_000,
  );
  const clear = () => {
    clearTimeout(total);
    clearTimeout(idle);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: abort.signal,
    });
    clearTimeout(idle);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError(502, `下載專案封存檔失敗（${response.status}）`);
    }
    reader = response.body.getReader();
    const source = reader;
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        // 只計算等待網路資料的時間；下游解壓背壓不算網路停滯。
        idle = setTimeout(
          () => abort.abort(new Error("封存檔傳輸停滯（60 秒未收到資料）")),
          60_000,
        );
        try {
          abort.signal.throwIfAborted();
          const { done, value } = await source.read();
          clearTimeout(idle);
          if (cancelled) return;
          if (done) {
            clear();
            source.releaseLock();
            c.close();
          } else c.enqueue(value);
        } catch (error) {
          clear();
          const reason = abort.signal.aborted ? abort.signal.reason : error;
          abort.abort(reason);
          if (!cancelled) {
            source.releaseLock();
            c.error(reason);
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        clear();
        abort.abort(reason);
        await source.cancel(reason).catch(() => {});
        source.releaseLock();
      },
    });
  } catch (error) {
    clear();
    const reason = abort.signal.aborted ? abort.signal.reason : error;
    abort.abort(reason);
    reader?.releaseLock();
    throw reason;
  }
}
