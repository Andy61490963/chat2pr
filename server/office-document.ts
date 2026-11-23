import { posix } from "node:path";
import { setImmediate } from "node:timers/promises";
import { SaxesParser } from "saxes";
import { fromBufferPromise, type Entry } from "yauzl";

interface XmlReader {
  open?(tag: string, attributes: Record<string, string>): void;
  text?(tag: string, value: string): void;
  close?(tag: string): void;
}

const local = (name: string) => name.slice(name.lastIndexOf(":") + 1);
const invalid = () => new Error("無法讀取 Office 文件。");

export async function readOfficeDocument(
  format: ".docx" | ".xlsx" | ".pptx",
  data: Buffer,
  limit: number,
) {
  // 只解開需要的 XML；套件中的媒體、外部連結與內嵌物件均不開啟。
  const archive = await fromBufferPromise(data, { strictFileNames: true });
  const deadline = Date.now() + 8000;
  let remaining = 16 * 1024 * 1024,
    output = "",
    nodes = 0;
  const append = (value: string) => {
    output += value.slice(0, limit - output.length);
  };
  const entries = new Map<string, Entry>();
  async function parse(path: string, root: string, reader: XmlReader) {
    const entry = entries.get(path);
    if (!entry || entry.uncompressedSize > remaining || Date.now() > deadline)
      throw invalid();
    remaining -= entry.uncompressedSize;
    const stream = await archive.openReadStreamPromise(entry);
    const parser = new SaxesParser();
    const stack: string[] = [];
    let decoder: TextDecoder | undefined;
    parser.on("doctype", () => {
      throw invalid();
    });
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      if (
        ++nodes > 250_000 ||
        stack.length >= 128 ||
        (!stack.length && name !== root)
      )
        throw invalid();
      stack.push(name);
      reader.open?.(name, tag.attributes);
    });
    parser.on("closetag", () => reader.close?.(stack.pop()!));
    const content = (value: string) =>
      reader.text?.(stack[stack.length - 1], value);
    parser.on("text", content);
    parser.on("cdata", content);
    for await (const chunk of stream) {
      if (!decoder) {
        const encoding =
          chunk[0] === 0xff && chunk[1] === 0xfe
            ? "utf-16le"
            : chunk[0] === 0xfe && chunk[1] === 0xff
              ? "utf-16be"
              : "utf-8";
        decoder = new TextDecoder(encoding, { fatal: true });
      }
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        if (Date.now() > deadline) throw invalid();
        parser.write(
          decoder.decode(chunk.subarray(offset, offset + 65536), {
            stream: true,
          }),
        );
        await setImmediate();
      }
    }
    parser.write(decoder?.decode() ?? "").close();
  }

  try {
    if (archive.entryCount > 2048) throw invalid();
    for await (const entry of archive.eachEntry()) {
      if (
        Date.now() > deadline ||
        entry.isEncrypted() ||
        entries.has(entry.fileName)
      )
        throw invalid();
      entries.set(entry.fileName, entry);
    }
    if (!entries.has("[Content_Types].xml")) throw invalid();
    const paragraphs: XmlReader = {
      open(tag) {
        if (tag === "tab") append("\t");
        else if (tag === "br") append("\n");
      },
      text(tag, value) {
        if (tag === "t") append(value);
      },
      close(tag) {
        if (tag === "p" || tag === "tr") append("\n");
      },
    };
    if (format === ".docx") {
      await parse("word/document.xml", "document", paragraphs);
      return output;
    }

    const sheets = format === ".xlsx";
    const folder = sheets ? "xl" : "ppt";
    const main = sheets ? "workbook" : "presentation";
    const paths = new Map<string, string>();
    await parse(folder + "/_rels/" + main + ".xml.rels", "Relationships", {
      open(tag, a) {
        if (tag !== "Relationship" || a.TargetMode === "External" || !a.Target)
          return;
        const path = posix.normalize(
          a.Target.startsWith("/")
            ? a.Target.slice(1)
            : posix.join(folder, a.Target),
        );
        if (
          (sheets
            ? /^xl\/worksheets\/[^/]+\.xml$/
            : /^ppt\/slides\/[^/]+\.xml$/
          ).test(path)
        )
          paths.set(a.Id, path);
      },
    });
    const pages: { label: string; path: string }[] = [];
    await parse(folder + "/" + main + ".xml", main, {
      open(tag, a) {
        if (tag !== (sheets ? "sheet" : "sldId")) return;
        const relationship = Object.keys(a).find((key) => key.endsWith(":id"));
        const path = relationship && paths.get(a[relationship]);
        if (path)
          pages.push({
            label: sheets ? a.name : "投影片 " + (pages.length + 1),
            path,
          });
      },
    });
    const shared: string[] = [];
    if (sheets && entries.has("xl/sharedStrings.xml")) {
      let value = "";
      await parse("xl/sharedStrings.xml", "sst", {
        open(tag) {
          if (tag === "si") value = "";
        },
        text(tag, text) {
          if (tag === "t") value += text;
        },
        close(tag) {
          if (tag === "si") shared.push(value);
        },
      });
    }
    let hasContent = false;
    for (const page of pages) {
      if (output.length >= limit) break;
      const previous = output;
      append("【" + page.label + "】\n");
      const start = output.length;
      if (sheets) {
        let type = "",
          address = "",
          formula = "",
          value = "";
        await parse(page.path, "worksheet", {
          open(tag, a) {
            if (tag === "c") {
              type = a.t ?? "";
              address = a.r ?? "";
              formula = "";
              value = "";
            }
          },
          text(tag, text) {
            if (tag === "t" || tag === "v") value += text;
            else if (tag === "f") formula += text;
          },
          close(tag) {
            if (tag !== "c") return;
            if (type === "s")
              value = /^\d+$/.test(value) ? (shared[Number(value)] ?? "") : "";
            if (!value && formula) value = "公式 " + formula;
            if (value) append(address + "=" + value + "\n");
          },
        });
      } else await parse(page.path, "sld", paragraphs);
      if (output.slice(start).trim()) hasContent = true;
      else output = previous;
    }
    return hasContent ? output : "";
  } finally {
    archive.close();
  }
}
