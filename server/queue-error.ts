import type { WorkHandler } from "pg-boss";

/** pg-boss 會序列化 Error 的自有欄位；不可把供應商 request/response 寫入資料庫。 */
export function safeQueueHandler<T>(handler: WorkHandler<T>): WorkHandler<T> {
  return async (jobs) => {
    try {
      return await handler(jobs);
    } catch (error) {
      let reason = "";
      if (error && typeof error === "object") {
        const fields = error as Record<string, unknown>;
        // SDK 可能把網路逾時包成 HTTP 500；只讀有限診斷，不複製 cause。
        const causes: Record<string, unknown>[] = [];
        let current: unknown = error;
        for (
          let depth = 0;
          depth < 3 && current && typeof current === "object";
          depth++
        ) {
          if (causes.includes(current as Record<string, unknown>)) break;
          causes.push(current as Record<string, unknown>);
          current = (current as Record<string, unknown>).cause;
        }
        const status = [fields.status, fields.statusCode].find(
          (value) =>
            Number.isInteger(value) &&
            Number(value) >= 100 &&
            Number(value) <= 599,
        );
        if (
          causes.some((value) =>
            ["AbortError", "TimeoutError"].includes(String(value.name)),
          )
        )
          reason = "（連線逾時或中止）";
        else if (status !== undefined) reason = `（HTTP ${status}）`;
        else if (
          [
            "ECONNREFUSED",
            "ECONNRESET",
            "ETIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
          ].includes(String(fields.code))
        )
          reason = `（${fields.code}）`;
      }
      // 不沿用任意訊息、堆疊、cause 或附件；沒有固定格式的原因保守顯示通用錯誤。
      throw new Error(
        `背景工作執行失敗${reason}，請查看服務狀態與任務時間軸。`,
      );
    }
  };
}
