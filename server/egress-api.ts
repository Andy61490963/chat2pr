import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireAdmin } from "./auth.js";
import { AppError } from "./policy.js";
import {
  DEFAULT_EGRESS_DOMAINS,
  MAX_EGRESS_DOMAINS,
  egressDomains,
  validateDomains,
} from "../shared/install-plan.js";
import type { EgressSettings } from "../shared/install-plan.js";

type Call = <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;

/**
 * 看板「系統」頁的下載來源白名單：安裝階段、系統套件安裝與開發時下載套件共用。
 * 變更寫稽核並立即同步到 egress；執行器暫時連不上時仍保存，下一次用到出口前會再同步。
 */
export function registerEgress(app: FastifyInstance, db: Database, call: Call) {
  app.get("/api/egress", async (req): Promise<EgressSettings> => {
    await requireAdmin(db, req);
    const s = await db.settings();
    return {
      domains: egressDomains(s),
      defaults: [...DEFAULT_EGRESS_DOMAINS],
      custom: Array.isArray(s.egress_domains),
      max: MAX_EGRESS_DOMAINS,
    };
  });
  app.put("/api/egress", async (req) => {
    const admin = await requireAdmin(db, req);
    const b = z
      .object({
        domains: z
          .array(z.string().max(300))
          .max(MAX_EGRESS_DOMAINS * 2)
          .default([]),
        // 還原預設：之後預設清單增加的來源也會自動生效。
        reset: z.boolean().default(false),
      })
      .parse(req.body);
    const { domains, errors } = b.reset
      ? { domains: [...DEFAULT_EGRESS_DOMAINS], errors: [] as string[] }
      : validateDomains(b.domains);
    if (errors.length) throw new AppError(400, errors.slice(0, 5).join("；"));
    const before = egressDomains(await db.settings());
    const added = domains.filter((d) => !before.includes(d));
    const removed = before.filter((d) => !domains.includes(d));
    if (b.reset)
      await db.query(
        "UPDATE settings SET value=value - 'egress_domains' WHERE id=1",
      );
    else
      await db.query(
        "UPDATE settings SET value=value || $1::jsonb WHERE id=1",
        [JSON.stringify({ egress_domains: domains })],
      );
    await db.audit(
      null,
      "egress",
      `管理者 ${admin.login} ${b.reset ? "將下載來源白名單還原為預設" : "更新下載來源白名單"}：${
        [
          added.length ? `新增 ${added.join("、")}` : "",
          removed.length ? `移除 ${removed.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("；") || "沒有變更"
      }（共 ${domains.length} 個）`,
    );
    let warning: string | null = null;
    try {
      await call("egress", { domains }, 30000);
    } catch (e) {
      warning = `已保存，但暫時無法更新套件出口代理：${e instanceof Error ? e.message : String(e)}。下一次安裝前會再同步。`;
    }
    return { ok: true, domains, warning };
  });
}
