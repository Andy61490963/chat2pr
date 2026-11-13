import type { Database } from "./db.js";
import type { Embedder } from "./embedder.js";
import type { GitHub } from "./github.js";
import { config, secrets } from "./config.js";
import { prices } from "./budget.js";
import { redact } from "./policy.js";
import { recordHealth } from "./health.js";

// 檢查外部服務連線並寫入 service_health。管理者按「檢查連線」與每小時維護共用，
// 讓設定頁的「正常」代表近期確認過，而不是上次有人手動檢查的結果。
export async function checkIntegrations(
  db: Database,
  github: Pick<GitHub, "repos">,
  embedder: Embedder,
) {
  const s = secrets(),
    settings = await db.settings();
  const runnerHeaders = { "x-runner-key": s.runnerSecret ?? "" };
  const checks: Record<string, () => Promise<void>> = {
    codex: async () => {
      const r = await fetch(`${config().runnerUrl}/codex/status`, {
        headers: runnerHeaders,
        signal: AbortSignal.timeout(5000),
      });
      const status = (await r.json()) as { loggedIn?: boolean };
      if (!r.ok || !status.loggedIn)
        throw new Error("服務的 Codex 尚未登入，請執行 npm run codex:login");
    },
    openai: async () => {
      if (!s.openaiKey) throw new Error("尚未設定");
      for (const model of new Set([
        settings.triage_model,
        settings.coding_model,
      ])) {
        if (!prices[model]) throw new Error("模型尚無費率設定");
        const r = await fetch(`https://api.openai.com/v1/models/${model}`, {
          headers: { Authorization: `Bearer ${s.openaiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`模型存取失敗（${r.status}）`);
      }
    },
    github: async () => {
      await github.repos();
    },
    line: async () => {
      if (!s.lineToken || !s.lineSecret) throw new Error("尚未設定");
      const r = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${s.lineToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`帳號驗證失敗（${r.status}）`);
    },
    runner: async () => {
      const r = await fetch(`${config().runnerUrl}/health`, {
        headers: runnerHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error("執行器未就緒");
    },
  };
  if (settings.rag_enabled) {
    checks.embedder = async () => {
      await embedder.embed(["本機向量模型連線測試"]);
    };
  }
  // 只檢查目前模式會用到的 AI 服務。
  delete checks[settings.ai_mode === "api" ? "codex" : "openai"];
  for (const [name, check] of Object.entries(checks)) {
    let ok = true,
      detail = "連線正常";
    try {
      await check();
    } catch (e) {
      ok = false;
      detail = redact(String(e));
    }
    await recordHealth(db, name, ok, detail);
  }
}
