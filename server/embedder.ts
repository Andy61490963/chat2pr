export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export class HttpEmbedder implements Embedder {
  constructor(
    private readonly url = process.env.EMBEDDER_URL ?? "http://embedder:80",
    private readonly request: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const inputs = texts.slice(i, i + 16);
      const signal = AbortSignal.timeout(30_000);
      try {
        const response = await this.request(new URL("/embed", this.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputs, truncate: true }),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`本機向量模型回應 HTTP ${response.status}`);
        }
        const batch: unknown = await response.json();
        if (
          !Array.isArray(batch) ||
          batch.length !== inputs.length ||
          !batch.every(
            (v) =>
              Array.isArray(v) && v.length === 1024 && v.every(Number.isFinite),
          )
        ) {
          throw new Error("本機向量模型回傳的筆數、維度或數值錯誤");
        }
        vectors.push(...batch);
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof Error && error.name === "TimeoutError")
        )
          throw new Error("本機向量模型逾時（30 秒）");
        if (error instanceof TypeError)
          throw new Error("無法連線到本機向量模型");
        if (error instanceof SyntaxError)
          throw new Error("本機向量模型回傳無效 JSON");
        throw error;
      }
    }
    return vectors;
  }
}
