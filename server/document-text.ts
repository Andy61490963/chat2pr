import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { readOfficeDocument } from "./office-document.js";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 24_000;
const shortened = "\n〔文件較長，僅擷取前段文字〕";
const formats = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
]);

export function documentName(name: string) {
  return (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 255);
}

export function supportsDocument(name: string) {
  return formats.has(extname(documentName(name)).toLowerCase());
}

class DocumentError extends Error {}

function decodeText(bytes: Buffer) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  let value;
  try {
    value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    if (encoding !== "utf-8") throw error;
    value = new TextDecoder("big5", { fatal: true }).decode(bytes);
  }
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(value))
    throw new DocumentError("文件包含無法讀取的二進位資料。");
  return value;
}

function poppler(
  tool: "pdfinfo" | "pdftotext",
  args: string[],
  input: Buffer | undefined,
  limit: number,
) {
  let program: string = tool;
  if (process.platform === "linux") {
    program = "prlimit";
    args = [
      "--as=268435456",
      "--cpu=5",
      "--fsize=16777216",
      "--",
      tool,
      ...args,
    ];
  } else if (process.platform === "win32") {
    const bundled = join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "mingw64",
      "bin",
      tool + ".exe",
    );
    if (existsSync(bundled)) program = bundled;
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        LC_ALL: "C",
      },
    });
    let output = "",
      diagnostic = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk.slice(0, Math.max(0, limit - output.length));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      diagnostic += chunk.slice(0, Math.max(0, 1024 - diagnostic.length));
    });
    child.once("error", () =>
      reject(new DocumentError("PDF 讀取工具無法啟動。")),
    );
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else if (/password/i.test(diagnostic))
        reject(new DocumentError("無法讀取加密 PDF。"));
      else reject(new DocumentError("PDF 無法讀取或已超出處理限制。"));
    });
    child.stdin.on("error", () => {
      /* 子程序提早結束時，由 close 判定結果。 */
    });
    child.stdin.end(input);
  });
}

async function pdfText(bytes: Buffer) {
  if (!bytes.subarray(0, 1024).includes("%PDF-"))
    throw new DocumentError("檔案內容不是 PDF。");
  const info = await poppler("pdfinfo", ["-enc", "UTF-8", "-"], bytes, 256_000);
  if (info.length >= 256_000)
    throw new DocumentError("PDF 的中繼資料超出處理限制。");
  const pages = /^Pages:\s+(\d+)\s*$/m.exec(info);
  if (
    !pages ||
    !/^Encrypted:\s+no\s*$/m.test(info) ||
    /^Encrypted:\s+yes\b/im.test(info)
  )
    throw new DocumentError("PDF 已加密或無法辨識。");
  // Git for Windows 隨附的文字擷取工具僅接受檔案輸入。
  const args = ["-f", "1", "-l", "120", "-enc", "UTF-8", "-nopgbrk"];
  const run = (path: string, input?: Buffer) =>
    poppler("pdftotext", [...args, path, "-"], input, MAX_DOCUMENT_CHARS + 1);
  let output: string;
  if (process.platform === "win32") {
    const path = join(tmpdir(), "chat2pr-" + randomUUID() + ".pdf");
    const temp = await open(path, "wx", 0o600);
    try {
      await temp.writeFile(bytes);
      await temp.close();
      output = await run(path);
    } finally {
      await temp.close();
      await unlink(path);
    }
  } else output = await run("-", bytes);
  if (!output.trim())
    throw new DocumentError(
      "PDF 前 120 頁沒有可擷取的文字，請提供文字版或頁面圖片。",
    );
  return { text: output, truncated: Number(pages[1]) > 120 };
}

export async function extractDocumentText(
  name: string,
  bytes: Buffer,
): Promise<string> {
  try {
    const ext = extname(documentName(name)).toLowerCase();
    if (!formats.has(ext)) throw new DocumentError("尚未支援此文件格式。");
    if (bytes.length > MAX_DOCUMENT_BYTES)
      throw new DocumentError("文件超過 8 MiB 上限。");
    let text: string,
      truncated = false;
    if (ext === ".pdf") ({ text, truncated } = await pdfText(bytes));
    else if (ext === ".docx" || ext === ".xlsx" || ext === ".pptx")
      text = await readOfficeDocument(ext, bytes, MAX_DOCUMENT_CHARS + 1);
    else text = decodeText(bytes);
    truncated ||= text.length > MAX_DOCUMENT_CHARS;
    text = text
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .trim();
    if (!text) throw new DocumentError("文件沒有可擷取的文字。");
    if (!truncated) return text;
    return (
      text
        .slice(0, MAX_DOCUMENT_CHARS - shortened.length)
        .replace(/[\uD800-\uDBFF]$/u, "") + shortened
    );
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(
      "文件無法讀取，可能是格式不符、已加密或內容超出處理限制。",
    );
  }
}
