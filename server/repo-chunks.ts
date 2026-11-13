import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import {
  containsRepositoryCredential,
  sensitiveRepoPath,
} from "./repository-safety.js";
import { posix } from "node:path";
import { validIndexPath } from "../shared/repo-scope.js";

export type FileChunk = {
  path: string;
  chunk: number;
  line_start: number;
  line_end: number;
  content: string;
};
const omitted =
  /^(node_modules|bower_components|dist|bin|obj|build|coverage|vendor|vendors|packages|\.git|\.next|\.venv|venv|__pycache__)$/i;
const code = /\.(md|tsx?|jsx?|mjs|cjs|cs|cshtml|py|html?|css|sql|json)$/i;
const withinScope = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + "/");
function eligible(path: string, size: number, sensitive: string[]) {
  if (
    !path ||
    path.length > 1024 ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    path
      .split("/")
      .some((p) => !p || p === ".." || p === "." || omitted.test(p))
  )
    return false;
  if (
    !code.test(path) ||
    size > 200 * 1024 ||
    (/\.json$/i.test(path) && size >= 100 * 1024)
  )
    return false;
  if (
    /(?:\.min\.(js|css)|\.lock\.json|(?:^|\/)(?:package-lock|npm-shrinkwrap|composer\.lock)\.json)$/i.test(
      path,
    )
  )
    return false;
  return (
    !sensitiveRepoPath(path, sensitive) && !containsRepositoryCredential(path)
  );
}
export function* splitFile(path: string, text: string): Generator<FileChunk> {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let start = 0,
    offset = 0,
    chunk = 0;
  while (start < lines.length) {
    let end = start,
      parts: string[] = [],
      size = 0,
      nextOffset = offset;
    for (; end < lines.length; end++) {
      const line = lines[end].slice(end === start ? offset : 0);
      if (size && size + 1 + line.length > 1500) break;
      if (line.length > 1500) {
        const boundary = (n: number) =>
          /[\uD800-\uDBFF]/.test(line[n - 1]) ? n - 1 : n;
        parts.push(line.slice(0, boundary(1500)));
        nextOffset = offset + boundary(1300);
        break;
      }
      parts.push(line);
      size += line.length + 1;
    }
    const content = parts.join("\n");
    if (content.trim())
      yield {
        path,
        chunk: chunk++,
        line_start: start + 1,
        line_end: start + parts.length,
        content,
      };
    if (nextOffset !== offset) {
      offset = nextOffset;
      continue;
    }
    offset = 0;
    if (end >= lines.length) break;
    let next = end,
      overlap = 0;
    while (next > start + 1 && overlap + lines[next - 1].length + 1 <= 200) {
      overlap += lines[--next].length + 1;
    }
    start = next;
  }
}

// 每個檔案先保留第一段，再依段序分配剩餘名額，避免大檔擠掉後面目錄。
export async function archiveChunks(
  body: ReadableStream<Uint8Array>,
  sensitive: string[],
  limit = 5000,
  indexPaths: string[] = [],
): Promise<FileChunk[]> {
  return (await archiveChunksWithStats(body, sensitive, limit, indexPaths))
    .chunks;
}

/** 計算所有合格段落，不把達到儲存上限的部分內容假稱完整索引。 */
export async function archiveChunksWithStats(
  body: ReadableStream<Uint8Array>,
  sensitive: string[],
  limit = 5000,
  indexPaths: string[] = [],
): Promise<{
  chunks: FileChunk[];
  total: number;
  limit: number;
  truncated: boolean;
  unmatchedPaths: string[];
}> {
  if (indexPaths.length > 50 || !indexPaths.every(validIndexPath))
    throw new Error("索引範圍含無效路徑");
  const matched = new Set<string>();
  const buckets: FileChunk[][] = [];
  let count = 0,
    last = 0,
    total = 0;
  const tar = extract(),
    input = Readable.fromWeb(
      body as import("node:stream/web").ReadableStream<Uint8Array>,
    );
  const piping = pipeline(input, createGunzip(), tar);
  void piping.catch(() => {});
  try {
    for await (const entry of tar) {
      const { name, size, type } = entry.header;
      const path = name.split("/").slice(1).join("/");
      const selected =
        type === "file" &&
        size !== undefined &&
        eligible(path, size, sensitive) &&
        (!indexPaths.length ||
          indexPaths.some((prefix) => withinScope(path, prefix)));
      const data: Buffer[] = [];
      for await (const piece of entry)
        if (selected && Buffer.isBuffer(piece)) data.push(piece);
      if (!selected) continue;
      const binary = Buffer.concat(data);
      if (binary.includes(0)) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(binary);
      } catch {
        continue;
      }
      // 含常見憑證或私鑰的整份檔案不送入模型。
      if (containsRepositoryCredential(text)) continue;
      for (const item of splitFile(path, text)) {
        for (const prefix of indexPaths)
          if (withinScope(path, prefix)) matched.add(prefix);
        total++;
        if (count >= limit) {
          if (item.chunk >= last) continue;
          buckets[last].pop();
          count--;
          while (last > 0 && !buckets[last]?.length) last--;
        }
        (buckets[item.chunk] ??= []).push(item);
        count++;
        last = Math.max(last, item.chunk);
      }
    }
    await piping;
    return {
      chunks: buckets.flat(),
      total,
      limit,
      truncated: total > limit,
      unmatchedPaths: indexPaths.filter((prefix) => !matched.has(prefix)),
    };
  } finally {
    tar.destroy();
    input.destroy();
    await piping.catch(() => {});
  }
}
