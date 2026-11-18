/** 登入過期（401）：看板據此回到登入頁，並把訊息顯示在登入頁上。 */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

// 寫入動作被 401 擋下時要講明「剛才的操作沒有完成」，使用者才知道登入後要再做一次。
export function expiredMessage(method = "GET") {
  return ["GET", "HEAD"].includes(method.toUpperCase())
    ? "登入已失效，請重新登入。"
    : "登入已失效，剛才的操作沒有完成，請重新登入。";
}

// 隧道或反向代理離線時可能回傳 HTML，不能把頁面內容或 JSON 解析堆疊顯示給使用者。
export async function readApiResponse<T>(
  response: Response,
  method = "GET",
): Promise<T> {
  if (response.status === 401)
    throw new SessionExpiredError(expiredMessage(method));
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

/**
 * 看板開啟時確認服務與登入狀態。configured 為 null 代表連不上服務：
 * 通道停了會回 502／530 的 HTML 頁，`/api/me` 回 5xx 或內容不是 JSON 也一樣，
 * 登入頁要給「重新連線」，不能誤說成尚未設定、叫人去執行 npm run setup。
 */
export async function probeService<U>(
  get: (url: string) => Promise<Response>,
): Promise<{ configured: boolean | null; user: U | null }> {
  try {
    const info = await readApiResponse<{ githubConfigured?: boolean }>(
      await get("/api/public/status"),
    );
    const me = await get("/api/me");
    // 401 只是還沒登入；服務以 JSON 回的其他 4xx（例如已不在成員名單）也回登入頁。
    // 5xx、代理回的 HTML 頁由 readApiResponse 丟出，當成連不上。
    const answered =
      me.status === 401 ||
      (me.status >= 400 &&
        me.status < 500 &&
        /json/i.test(me.headers.get("content-type") ?? ""));
    const user = answered ? null : await readApiResponse<U>(me);
    return { configured: !!info.githubConfigured, user };
  } catch {
    return { configured: null, user: null };
  }
}
