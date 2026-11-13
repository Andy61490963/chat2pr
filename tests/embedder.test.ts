import { describe, it, expect, vi } from "vitest";
import { HttpEmbedder } from "../server/embedder.js";

const vector = (value: number) => Array<number>(1024).fill(value);

describe("本機向量模型 HTTP 介面", () => {
  it("分批送出文字，照輸入順序回傳完整向量；空輸入零呼叫", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const { inputs } = JSON.parse(String(init?.body)) as { inputs: string[] };
      return Response.json(inputs.map((text) => vector(Number(text))));
    });
    const client = new HttpEmbedder("http://embedder", request);
    expect(await client.embed([])).toEqual([]);
    const inputs = Array.from({ length: 33 }, (_, i) => String(i));
    expect((await client.embed(inputs)).map((v) => v[0])).toEqual(
      inputs.map(Number),
    );
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each([[], [[1]], [vector(0).fill(NaN)]].map((result) => ({ result })))(
    "拒絕不合格式的結果",
    async ({ result }) => {
      const client = new HttpEmbedder("http://embedder", async () =>
        Response.json(result),
      );
      await expect(client.embed(["測試"])).rejects.toThrow(
        "筆數、維度或數值錯誤",
      );
    },
  );
  it("每批 30 秒後取消請求，回報逾時", async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        setTimeout(
          () => signal.abort(new DOMException("逾時", "TimeoutError")),
          ms,
        );
        return signal.signal;
      });
    try {
      const client = new HttpEmbedder(
        "http://embedder",
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      const failure = expect(client.embed(["測試"])).rejects.toThrow("逾時");
      await vi.advanceTimersByTimeAsync(30_000);
      await failure;
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
