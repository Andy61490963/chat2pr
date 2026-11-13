import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";

export const reportDirectory = "/tmp/agentflow-report";
export const queryReportInstructions = `
請為想快速理解答案的人寫報告，不要把調查過程或功能盤點當成答案。先辨識使用者問的是用途、欄位比較、流程、即時狀態或簡短事實，再決定深度；驗收項目是回答範圍，不代表每項都要展開一大節。
請用 Markdown 依下列順序寫報告，省略不需要的段落。
## 先看重點
第一句用一至兩句白話直接回答，先說「是什麼／有沒有／用哪個」，不要用抽象架構名詞開場。第一句結論使用粗體，例子另起一段，避免整段文字黏在一起。這段目標 80～180 個中文字，必要時最多約 250 字；簡短事實題可以只有一句，不強制列點。最多三點，每點只講一件事，不重複第一句。影響結論的重要限制必須在此說明，不能藏在收合內容。
功能用途題：先說使用者拿它做什麼，再給一個有來源支持的具體例子；不要先列所有模式、API 或技術限制。欄位比較題：逐一直接說明題目指定欄位的用途，可用兩三列小表格；英文欄位名保留並搭配中文用途。流程題：先說起點與結果。狀態／進度題：先回答已確認的目前狀態；沒有即時證據時，第一句必須說「目前無法確認……」，先看重點只寫無法確認的事項、缺少什麼證據及確認方式，不列歷史完成項目或舊待辦。歷史紀錄只能放在詳細資訊並標明時間，不可把舊文件的待辦或操作要求當成今日現況與行動建議。不能把合併紀錄或查詢容器的狀態當成正式環境現況。
例子放在這段內，用「例如：」引出；假設情境要標明是假設，沒有證據的具體業務用途不要編造。除使用者指定的欄位名外，前段避免 TVF、View、一對多、Controller、交易等術語；必要時先翻成日常用途。
## 簡易圖解
只有圖比文字更能回答本題時才加入。使用 mermaid flowchart TD，主圖以 3～5 個節點為主，最多 7 個；節點用簡短中文，圖後最多一句話。一次只畫一個角色或一條資料流，不把表單設計、日常操作與內部寫入混在同一圖。用途題可畫具體使用例子；欄位題若涉及來源轉換、比對與結果，應提供這三個步驟的簡圖，不要把整個流程藏在詳細資訊；只問單一欄位定義則不必畫。進度題只能標示有證據的狀態，未知就標未知，不能用通用流程冒充進度。簡短事實題或資訊不足題通常省略圖解。
## 詳細資訊
這段在看板預設收合。只補充回答本題必要的條件、例外與細節，不再重述摘要，不主動擴大到完整功能盤點或程式審查。簡單用途題的全文以約 400～800 字為目標，簡短事實題更短；使用者明確要求完整調查或複雜流程時才加長，不得為了字數省略會改變結論的條件。未取得證據時簡短說明缺什麼，以及如何確認；不要反覆列出不影響本題的未知項目。
## 程式依據
這段在看板獨立收合。將程式路徑、行號、API、SQL 與查詢證據集中於此，每項用「支持的結論：儲存庫相對路徑與行號」呈現；內文必要時用 [依據 1] 這類純文字標記對照。不要建立無法開啟的 /workspace 本機連結。歷史資料標明時間與適用範圍。不要在前段堆疊連結、內部執行識別碼或「本次未修改檔案」等執行宣告。報告不必解釋附件輸出目錄、manifest.json 或 base64 等內部傳輸方式。
需要圖片才補圖，使用本任務提供的來源圖片、專案既有圖片或可存取的真實畫面截圖，不可生成或偽造實際畫面。最多三張 PNG/JPEG/WebP，每張最多 2 MiB，合計最多 6 MiB。先遮蔽憑證、個人資料和無關內容。
將附件複製或截圖保存到 /tmp/agentflow-report，目錄內使用單層英數檔名。建立 manifest.json，內容為陣列，每項包含 key（例如 img-1）、file（例如 screen.png）、caption（中文用途）、kind（message、repository 或 screenshot）、source（訊息 ID、儲存庫相對路徑或不含認證及查詢參數的畫面網址）。screenshot 另外填 capturedAt（ISO 時間）。在詳細資訊適當位置用 ![中文圖說](report:img-1) 引用。來源訊息圖片的 source 必須使用提供的 sourceId。圖片擷取失敗時以文字交代。所有附件都必須在最後回覆前完成。
`;

// 輸出目錄與檔名均固定範圍，禁止藉連結讀取任意檔案。
async function readRegularFile(folder, name, limit) {
  const info = await lstat(join(folder, name));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new Error("附件不可使用連結");
  const handle = await open(
    join(folder, name),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > limit)
      throw new Error("附件檔案大小或類型無效");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("附件超過大小限制");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function collectReportImages(folder = reportDirectory) {
  const images = [];
  const warnings = [];
  let directory;
  try {
    if ((await realpath(folder)) !== folder)
      throw new Error("附件目錄不可使用連結");
    directory = await open(
      folder,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    // 固定目錄描述符，背景程序更換路徑也不能讓收集器走出報告目錄。
    const anchored = "/proc/self/fd/" + directory.fd;
    const manifest = JSON.parse(
      (await readRegularFile(anchored, "manifest.json", 12000)).toString(
        "utf8",
      ),
    );
    if (!Array.isArray(manifest) || manifest.length > 3)
      throw new Error("附件清單最多三張");
    for (const entry of manifest) {
      try {
        if (!/^[a-zA-Z0-9_-]{1,40}\.(png|jpe?g|webp)$/.test(entry.file ?? ""))
          throw new Error("附件檔名無效");
        const data = await readRegularFile(
          anchored,
          entry.file,
          2 * 1024 * 1024,
        );
        const extension = entry.file.split(".").at(-1);
        images.push({
          ...entry,
          mime:
            extension === "png"
              ? "image/png"
              : extension === "webp"
                ? "image/webp"
                : "image/jpeg",
          data: data.toString("base64"),
        });
      } catch {
        warnings.push("一張補充圖片無法讀取，請依文字說明核對。");
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      warnings.push("補充圖片清單無法讀取，請依文字說明核對。");
  } finally {
    await directory?.close();
  }
  return { images, warnings };
}
