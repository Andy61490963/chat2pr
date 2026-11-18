// 隧道或反向代理離線時可能回傳 HTML，不能把頁面內容或 JSON 解析堆疊顯示給使用者。
export async function readApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new Error("登入已失效，請重新登入。");
  const fallback =
    response.status >= 500
      ? `服務暫時無法連線（HTTP ${response.status}），請稍後再試。`
      : response.ok
        ? "服務回應格式異常，請重新整理或稍後再試。"
        : `操作未完成（HTTP ${response.status}），請稍後再試。`;
  if (
    !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw new Error(fallback);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? result.error
        : undefined;
    const details =
      result && typeof result === "object" && "details" in result
        ? result.details
        : undefined;
    const base = typeof error === "string" ? error : fallback;
    const specific = fieldMessages(details);
    throw new Error(specific.length ? `${base}：${specific.join("；")}` : base);
  }
  return result as T;
}

// 輸入格式錯誤的 details 是「欄位路徑: 訊息」。只採用伺服器寫好的中文提示；
// zod 的英文預設訊息與欄位路徑對管理者沒有意義，不顯示。
function fieldMessages(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const messages = details
    .filter((d): d is string => typeof d === "string")
    .slice(0, 3)
    .map((d) => d.replace(/^[\w.[\]-]*:\s*/, "").trim())
    .filter((d) => /[一-鿿]/.test(d));
  return [...new Set(messages)];
}
