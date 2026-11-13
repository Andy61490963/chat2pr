import type { Embedder } from "./embedder.js";
import type { FileChunk } from "./repo-chunks.js";

const ignored = new Set(
  "const function return that this value string true false void async public import export class static null from var let wwwroot data type".split(
    " ",
  ),
);
const segmenter = new Intl.Segmenter("zh-TW", { granularity: "word" });
function terms(text: string) {
  const tokens =
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9]{1,39}|[\p{Script=Han}]{1,100}/gu) ?? [];
  return tokens
    .flatMap((t) =>
      /\p{Script=Han}/u.test(t)
        ? [...segmenter.segment(t)].map((s) => s.segment)
        : [t],
    )
    .filter((t) => t.length > 1 && !ignored.has(t));
}
// 在 CPU 上重用同一個專案的詞向量。詞典有固定上限，段落原文與行號另存供判讀引用。
export async function* fileVectors(
  chunks: FileChunk[],
  model: Embedder,
  check: () => Promise<boolean>,
) {
  if (!chunks.length) return;
  const docs = new Map<string, number>(),
    importance = new Map<string, number>();
  const features = chunks.map((chunk) => {
    const rank = new Map<string, number>();
    for (const term of terms(chunk.content))
      rank.set(term, Math.min(5, (rank.get(term) ?? 0) + 1));
    for (const term of terms(chunk.path))
      rank.set(term, (rank.get(term) ?? 0) + 12);
    for (const [term, weight] of rank) {
      docs.set(term, (docs.get(term) ?? 0) + 1);
      importance.set(term, (importance.get(term) ?? 0) + weight);
    }
    return [...rank].sort((a, b) => b[1] - a[1]).slice(0, 48);
  });
  const idf = (term: string) =>
    1 + Math.log((1 + chunks.length) / (1 + (docs.get(term) ?? 0)));
  const vocab = [...docs.keys()]
    .sort((a, b) => importance.get(b)! * idf(b) - importance.get(a)! * idf(a))
    .slice(0, 511);
  const fallback = "專案程式碼",
    words = [fallback, ...vocab],
    vectors = new Map<string, number[]>();
  for (let i = 0; i < words.length; i += 16) {
    if (!(await check())) return;
    const batch = words.slice(i, i + 16),
      results = await model.embed(batch);
    batch.forEach((term, n) => vectors.set(term, results[n]));
  }
  for (let i = 0; i < chunks.length; i++) {
    const sum = new Float64Array(1024);
    let used = false;
    for (const [term, freq] of features[i]) {
      const v = vectors.get(term);
      if (!v) continue;
      const weight = freq * idf(term);
      for (let k = 0; k < sum.length; k++) sum[k] += weight * v[k];
      used = true;
    }
    const norm = Math.hypot(...sum);
    yield {
      ...chunks[i],
      embedding:
        used && norm
          ? Array.from(sum, (v) => v / norm)
          : vectors.get(fallback)!,
    };
  }
}
