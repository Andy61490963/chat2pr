/** 連線例外可能含請求標頭，只把固定說明送到看板與紀錄；HTTP 狀態仍由呼叫端分類。 */
export async function fetchLine(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("無法連線至 LINE");
  }
}
