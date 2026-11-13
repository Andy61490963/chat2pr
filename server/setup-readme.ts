/** 說明文件只是輔助依據；優先保留安裝與測試附近的原文，限制送給 AI 的資料量。 */
export function setupReadmeExcerpt(source: string, limit: number) {
  if (Buffer.byteLength(source) <= limit) return source;
  const lines = source.split("\n"),
    selected = new Set<number>();
  // 每個不連續段落最多加一個省略標記，計入同一個位元組上限。
  const marker = "\n[此處省略說明文件內容]\n";
  let remaining = limit;
  const add = (start: number, end: number) => {
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
      if (selected.has(i)) continue;
      const size = Buffer.byteLength(lines[i]) + 1 + Buffer.byteLength(marker);
      if (size > remaining) continue;
      selected.add(i);
      remaining -= size;
    }
  };
  // 先取標題，再取命令與操作說明；不會只保留開頭而漏掉尾端的測試手順。
  add(0, 5);
  for (let i = 0; i < lines.length; i++)
    if (
      /(?:\b(?:install|restore|test|build|setup|prerequisites|quick\s*start|npm|pnpm|dotnet|pytest|docker)\b|安裝|測試|建置|環境|啟動|還原|相依)/i.test(
        lines[i],
      )
    )
      add(i - 2, i + 18);
  add(0, lines.length);
  let previous = -1;
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => {
      const prefix = i > previous + 1 ? marker : "";
      previous = i;
      return prefix + lines[i];
    })
    .join("\n");
}
