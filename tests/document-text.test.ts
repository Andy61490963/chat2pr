import { expect, it } from "vitest";
import { ZipFile } from "yazl";
import { buffer } from "node:stream/consumers";
import {
  documentName,
  extractDocumentText,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CHARS,
  supportsDocument,
} from "../server/document-text.js";

async function office(parts: Record<string, string>) {
  const zip = new ZipFile();
  const result = buffer(zip.outputStream);
  zip.addBuffer(Buffer.from("<Types/>"), "[Content_Types].xml");
  for (const [name, content] of Object.entries(parts))
    zip.addBuffer(Buffer.from(content), name);
  zip.end();
  return result;
}

// 建立含字型與交叉參照表的單頁 PDF；空字串代表沒有可讀文字的一頁。
function pdf(text: string) {
  const drawing = "BT /F1 12 Tf 30 100 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + drawing.length + " >>\nstream\n" + drawing + "\nendstream",
  ];
  let file = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f \n"];
  for (const [i, object] of objects.entries()) {
    offsets.push(String(file.length).padStart(10, "0") + " 00000 n \n");
    file += i + 1 + " 0 obj\n" + object + "\nendobj\n";
  }
  const start = file.length;
  return Buffer.from(
    file +
      "xref\n0 6\n" +
      offsets.join("") +
      "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
      start +
      "\n%%EOF\n",
  );
}

it("依檔名支援常用格式並移除路徑與控制字元", () => {
  expect(documentName("路徑\\章節/規格\t.MD")).toBe("規格.MD");
  expect(supportsDocument("規格.PDF")).toBe(true);
  expect(supportsDocument("規格.docm")).toBe(false);
  expect(supportsDocument("規格.pdf.exe")).toBe(false);
});

it("保留文字、表格及繁體中文編碼，截斷長文時附上提示", async () => {
  expect(
    await extractDocumentText("規格.md", Buffer.from("# 驗收\r\n保留清單")),
  ).toBe("# 驗收\n保留清單");
  expect(
    await extractDocumentText(
      "表格.csv",
      Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 44, 55]),
    ),
  ).toBe("中文,7");
  expect(
    await extractDocumentText(
      "表格.txt",
      Buffer.from("\ufeff品項\t7", "utf16le"),
    ),
  ).toBe("品項\t7");
  const value = await extractDocumentText(
    "長文.txt",
    Buffer.from("文".repeat(MAX_DOCUMENT_CHARS + 1)),
  );
  expect(value).toHaveLength(MAX_DOCUMENT_CHARS);
  expect(value).toContain("僅擷取前段文字");
});

it("擷取 Word 的多段文字、表格內文與 XML 實體", async () => {
  const data = await office({
    "word/document.xml":
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>金額 &amp; 數量</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>七箱</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  });
  expect(await extractDocumentText("驗收.docx", data)).toBe(
    "金額 & 數量\n七箱",
  );
});

it("依 Excel 頁籤順序擷取共用字串、座標及公式快取結果", async () => {
  const data = await office({
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="明細" r:id="a"/><sheet name="彙總" r:id="b"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="a" Target="worksheets/sheet2.xml"/><Relationship Id="b" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      "<sst><si><r><t>出</t></r><r><t>貨</t></r></si></sst>",
    "xl/worksheets/sheet2.xml":
      '<worksheet><sheetData><row><c r="B1" t="s"><v>0</v></c><c r="E1" t="inlineStr"><is><t>完成</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c r="C1"><f>3+4</f><v>7</v></c><c r="D1"><f>C1*3</f></c></row></sheetData></worksheet>',
  });
  expect(await extractDocumentText("出貨.xlsx", data)).toBe(
    "【明細】\nB1=出貨\nE1=完成\n【彙總】\nC1=7\nD1=公式 C1*3",
  );
});

it("依簡報編排順序擷取投影片標題與段落", async () => {
  const data = await office({
    "ppt/presentation.xml":
      '<p:presentation><p:sldIdLst><p:sldId id="300" r:id="b"/><p:sldId id="310" r:id="a"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:t>先核准</a:t></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:t>後派工</a:t></a:p></p:sld>",
  });
  expect(await extractDocumentText("程序.pptx", data)).toBe(
    "【投影片 1】\n先核准\n【投影片 2】\n後派工",
  );
});

it("從真正的 PDF 文字層讀取內容，沒有文字的頁面提供可行提示", async () => {
  expect(await extractDocumentText("出貨.pdf", pdf("BOXES 7"))).toBe("BOXES 7");
  await expect(extractDocumentText("掃描.pdf", pdf(""))).rejects.toThrow(
    "沒有可擷取的文字",
  );
});

it("拒絕變更副檔名的檔案、超限的輸入與展開過大的文件", async () => {
  await expect(
    extractDocumentText("錯誤.docx", Buffer.from("中文")),
  ).rejects.toThrow("文件無法讀取");
  await expect(
    extractDocumentText("錯誤.pdf", Buffer.from([0, 1, 2])),
  ).rejects.toThrow("不是 PDF");
  await expect(
    extractDocumentText("錯誤.txt", Buffer.from([0, 1, 2])),
  ).rejects.toThrow("二進位");
  await expect(
    extractDocumentText("過大.md", Buffer.alloc(MAX_DOCUMENT_BYTES + 1)),
  ).rejects.toThrow("8 MiB");
  const data = await office({
    "word/document.xml":
      "<document><t>" + "x".repeat(16 * 1024 * 1024) + "</t></document>",
  });
  await expect(extractDocumentText("過大.docx", data)).rejects.toThrow(
    "超出處理限制",
  );
});
