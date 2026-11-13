/** 從外部網址檢查 /health；沒有 status 代表連不上。 */
export function publicHealth(
  publicUrl: string,
): Promise<{ ok: boolean; status?: number; detail: string }>;
