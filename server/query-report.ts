import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { TaskImage } from "./image-context.js";
import type { ReportImage } from "../shared/query-report.js";
import { normalizeReportMarkdown } from "../shared/query-report.js";
import { validateImageContent } from "./image-content.js";
import { redact } from "./policy.js";
import { clip } from "./pr-body.js";

const imageSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  caption: z.string().trim().min(1).max(500),
  kind: z.enum(["message", "repository", "screenshot"]),
  source: z.string().trim().min(1).max(1000),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z
    .string()
    .max(2796204)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});

export async function prepareReportImages(raw: unknown, sources: TaskImage[]) {
  const images: (ReportImage & { mime: string; data: Buffer })[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { images, warnings };
  if (!Array.isArray(raw) || raw.length > 3)
    return {
      images,
      warnings: ["補充圖片超過三張或格式無效，請依文字說明核對。"],
    };
  for (const value of raw) {
    try {
      const image = imageSchema.parse(value);
      const data = Buffer.from(image.data, "base64");
      if (
        data.toString("base64") !== image.data ||
        data.length > 2 * 1024 * 1024 ||
        images.some((i) => i.key === image.key)
      )
        throw new Error("圖片內容無效");
      if (image.kind === "message") {
        const source = sources.find((s) => s.id === image.source);
        if (!source || source.mime !== image.mime || source.data !== image.data)
          throw new Error("圖片不屬於此需求版本");
      }
      if (
        image.kind === "repository" &&
        (image.source.startsWith("/") ||
          image.source.includes("\\") ||
          image.source.includes(":") ||
          image.source.split("/").includes(".."))
      )
        throw new Error("儲存庫路徑無效");
      if (image.kind === "screenshot") {
        const url = new URL(image.source);
        if (!["http:", "https:"].includes(url.protocol) || !image.capturedAt)
          throw new Error("截圖來源無效");
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        image.source = url.href;
      }
      await validateImageContent(data, image.mime);
      images.push({
        ...image,
        id: randomUUID(),
        data,
        caption: redact(image.caption),
        source: redact(image.source),
        capturedAt: image.capturedAt ?? null,
      });
    } catch {
      warnings.push("一張補充圖片未通過來源或內容檢查，請依文字說明核對。");
    }
  }
  return { images, warnings };
}

export function querySummary(answer: string) {
  const heading = /^##[ \t]+先看重點[ \t]*\r?\n/m.exec(answer);
  const section = heading
    ? answer.slice(heading.index + heading[0].length).split(/^##[ \t]+/m)[0]
    : answer;
  const text = section
    .replace(
      /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm,
      "",
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(
      /^\|([^\n]+)\|[ \t]*\r?\n\|[ \t:|-]+\|[ \t]*\r?\n((?:\|[^\n]+\|[ \t]*(?:\r?\n|$))+)/gm,
      (_match, _header: string, rows: string) =>
        rows
          .trim()
          .split(/\r?\n/)
          .map((row) => {
            const cells = row
              .trim()
              .slice(1, -1)
              .split(/(?<!\\)\|/)
              .map((cell) => cell.trim().replace(/\\\|/g, "｜"));
            return `• ${cells[0]}：${cells.slice(1).join("；")}`;
          })
          .join("\n") + "\n",
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/`/g, "")
    .trim();
  const more = "…（完整報告請看看板）";
  return clip(
    text || "查詢已完成，請開啟看板閱讀完整報告。",
    320 - more.length,
    more,
  );
}

export function reportForGitHub(answer: string, reportUrl: string) {
  return normalizeReportMarkdown(answer).replace(
    /!\[([^\]]*)\]\(report:[a-zA-Z0-9_-]+\)/g,
    (_match, caption: string) => `[查看圖片：${caption}](${reportUrl})`,
  );
}

export async function readReportImages(db: Database, taskId: string) {
  return db.query<ReportImage>(
    'SELECT id,key,caption,kind,source,captured_at AS "capturedAt" FROM query_report_images WHERE task_id=$1 AND query_report_image_visible(id) ORDER BY position',
    [taskId],
  );
}
