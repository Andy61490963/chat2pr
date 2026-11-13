// 隧道或反向代理離線時可能回傳 HTML，不能把頁面內容或 JSON 解析堆疊顯示給使用者。
export async function readApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new Error("登入已失效，請重新登入。");
  const fallback = response.status >= 500
    ? `服務暫時無法連線（HTTP ${response.status}），請稍後再試。`
    : response.ok
      ? "服務回應格式異常，請重新整理或稍後再試。"
      : `操作未完成（HTTP ${response.status}），請稍後再試。`;
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error(fallback);
  }
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error(fallback); }
  if (!response.ok) {
    const error = result && typeof result === "object" && "error" in result ? result.error : undefined;
    throw new Error(typeof error === "string" ? error : fallback);
  }
  return result as T;
}
