import sharp from "sharp";
import { AppError } from "./policy.js";

export const imageByteLimit = 10 * 1024 * 1024;
const formats: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif",
};
const options = { failOn: "warning" as const, limitInputPixels: 40000000, pages: 1, page: 0 };

/** 保留來源原始位元組；格式宣告、解碼與大小必須全部有效。 */
export async function validateImageContent(data: Buffer, mime: string) {
  if (!formats[mime]) throw new AppError(422, "不支援此圖片格式");
  if (data.length > imageByteLimit) throw new AppError(413, "圖片超過 10 MB，請人工確認");
  try {
    const image = sharp(data, options);
    const metadata = await image.metadata();
    if (metadata.format !== formats[mime]) throw new AppError(422, "圖片內容與宣告格式不一致");
    // metadata 讀取成功不代表像素完整，必須實際解碼。
    await image.stats();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "圖片無法解碼或超過 4,000 萬像素，請重新提供");
  }
}

/** GIF 僅以首幀辨識；來源雜湊仍由呼叫端對原始檔案計算。 */
export async function modelImageContent(data: Buffer, mime: string) {
  await validateImageContent(data, mime);
  return mime === "image/gif"
    ? { data: await sharp(data, options).png().toBuffer(), mime: "image/png" }
    : { data, mime };
}
