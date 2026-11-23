import { AppError } from "./policy.js";
import type { Line } from "./line.js";

export async function readChatImage(response: Response) {
  if (!response.ok || !response.body)
    throw new AppError(502, `無法取得圖片（${response.status}）`);
  const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime))
    throw new AppError(422, "不支援此圖片格式");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 10 * 1024 * 1024)
        throw new AppError(413, "圖片超過 10 MB，請人工確認");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = Buffer.concat(chunks);
  const { validateImageContent } = await import("./image-content.js");
  await validateImageContent(data, mime);
  return { data, mime };
}

export function discordImageUrl(raw: string) {
  const url = URL.parse(raw);
  return url?.protocol === "https:" &&
    ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^\/(?:ephemeral-)?attachments\/\d+\/\d+\//.test(url.pathname)
    ? url.href
    : null;
}

export async function loadChatImage(
  line: Pick<Line, "image">,
  message: { id: string; image_source_url?: string | null },
) {
  if (!message.id.startsWith("discord:")) return line.image(message.id);
  const url = discordImageUrl(message.image_source_url ?? "");
  if (!url) throw new AppError(422, "Discord 圖片連結無效，請發言者重新附圖。");
  return readChatImage(
    await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    }),
  );
}
