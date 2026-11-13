import { afterEach, expect, it, vi } from "vitest";
import { downloadArchive } from "../server/archive-download.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("大型封存檔持續傳輸超過十分鐘仍可完成", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("逾時", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  const request: typeof fetch = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let received = 0;
        const timer = setInterval(() => {
          c.enqueue(Uint8Array.of(++received));
          if (received === 35) {
            clearInterval(timer);
            c.close();
          }
        }, 20_000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearInterval(timer);
            c.error(init.signal?.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(body);
  };
  const result = downloadArchive(
    "https://example.test/archive",
    "fake",
    request,
  )
    .then((body) => new Response(body).arrayBuffer())
    .then((bytes) => bytes.byteLength);
  const checked = expect(result).resolves.toBe(35);
  void checked.catch(() => {});
  await vi.advanceTimersByTimeAsync(700_000);
  await checked;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["連線", "傳輸"])("%s停滯六十秒即取消，保留明確原因", async (stage) => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const request: typeof fetch = async (_url, init) => {
    signal = init!.signal!;
    if (stage === "連線")
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    return new Response(
      new ReadableStream({
        start(c) {
          signal!.addEventListener("abort", () => c.error(signal!.reason), {
            once: true,
          });
        },
      }),
    );
  };
  const result = downloadArchive(
    "https://example.test/archive",
    "fake",
    request,
  ).then((body) => new Response(body).arrayBuffer());
  const checked = expect(result).rejects.toThrow(
    stage === "連線" ? "連線逾時" : "傳輸停滯",
  );
  void checked.catch(() => {});
  await vi.advanceTimersByTimeAsync(59_000);
  expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await checked;
  expect(signal!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("下游取消時終止請求並釋放計時器", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const request: typeof fetch = async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({ cancel }));
  };
  const body = await downloadArchive(
    "https://example.test/archive",
    "fake",
    request,
  );
  await body.cancel("停止索引");
  expect(signal!.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledWith("停止索引");
  expect(vi.getTimerCount()).toBe(0);
});

it("下游背壓不當作網路停滯，但仍受三十分鐘總上限限制", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const request: typeof fetch = async (_url, init) => {
    signal = init!.signal!;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(Uint8Array.of(1));
          c.enqueue(Uint8Array.of(2));
          signal!.addEventListener("abort", () => c.error(signal!.reason), {
            once: true,
          });
        },
      }),
    );
  };
  const body = await downloadArchive(
    "https://example.test/archive",
    "fake",
    request,
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(28 * 60_000);
  expect(signal!.aborted).toBe(true);
  await expect(new Response(body).arrayBuffer()).rejects.toThrow(
    "超過 30 分鐘",
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("HTTP 失敗時取消回應本體，錯誤不包含憑證", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const request: typeof fetch = async () =>
    new Response(new ReadableStream({ cancel }), { status: 403 });
  await expect(
    downloadArchive("https://example.test/archive", "fake", request),
  ).rejects.toThrow("下載專案封存檔失敗（403）");
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
