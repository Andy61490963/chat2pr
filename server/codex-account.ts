import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { AppError } from "./policy.js";
type Window = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
type Snapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: Window | null;
  secondary: Window | null;
  planType: string | null;
  rateLimitReachedType: string | null;
};
export interface CodexAccount {
  plan: string | null;
  allowed: boolean | null;
  limits: Array<{
    id: string;
    name: string | null;
    windows: Array<{
      usedPercent: number;
      minutes: number | null;
      resetsAt: string | null;
    }>;
    reached: string | null;
  }>;
  models: Array<{
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
    efforts: string[];
    defaultEffort: string;
  }>;
  checkedAt: string;
}
// 以服務專用登入啟動一次性的 Codex app-server，只讀取額度與模型清單，不送出任何提示詞。
export async function readCodexAccount(
  codexHome: string,
  forceRefresh = false,
): Promise<CodexAccount> {
  const cli = createRequire(import.meta.url).resolve(
    "@openai/codex/bin/codex.js",
  );
  const child = spawn(process.execPath, [cli, "app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const pending = new Map<
    number,
    (m: { result?: unknown; error?: { message?: string } }) => void
  >();
  let stopped = false;
  const stopPending = () => {
    stopped = true;
    for (const finish of pending.values())
      finish({ error: { message: "可信 Codex 登入程序已中止" } });
    pending.clear();
  };
  child.once("error", stopPending);
  child.once("exit", stopPending);
  child.stdin.once("error", stopPending);
  let buffer = "",
    next = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number" && pending.has(m.id)) {
          pending.get(m.id)!(m);
          pending.delete(m.id);
        }
      } catch {
        // 非 JSON 的輸出行不影響讀取。
      }
    }
  });
  const call = <T>(method: string, params: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (stopped)
        return reject(new AppError(503, "可信 Codex 登入程序不可用"));
      const id = ++next;
      pending.set(id, (m) =>
        m.error
          ? reject(
              new AppError(502, `Codex 回應錯誤：${m.error.message ?? method}`),
            )
          : resolve(m.result as T),
      );
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timer = setTimeout(() => {
    stopPending();
    child.kill();
  }, 30000);
  try {
    await call("initialize", {
      clientInfo: { name: "line-agentflow", version: "0.1.0" },
      capabilities: null,
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    if (forceRefresh) await call("account/read", { refreshToken: true });
    const rl = await call<{
      ordinaryUsageAllowed: boolean | null;
      rateLimits: Snapshot;
      rateLimitsByLimitId: Record<string, Snapshot> | null;
    }>("account/rateLimits/read", { excludeResetCreditDetails: true });
    const ml = await call<{
      data: Array<{
        id: string;
        displayName: string;
        description: string;
        hidden: boolean;
        isDefault: boolean;
        supportedReasoningEfforts: Array<{ reasoningEffort?: string } | string>;
        defaultReasoningEffort: string;
      }>;
    }>("model/list", {});
    const snapshots = Object.values(rl.rateLimitsByLimitId ?? {}).filter(
      (s): s is Snapshot => !!s,
    );
    return {
      plan: rl.rateLimits.planType,
      allowed: rl.ordinaryUsageAllowed,
      limits: (snapshots.length ? snapshots : [rl.rateLimits]).map((s) => ({
        id: s.limitId ?? "codex",
        name: s.limitName,
        reached: s.rateLimitReachedType,
        windows: [s.primary, s.secondary]
          .filter((w): w is Window => !!w)
          .map((w) => ({
            usedPercent: w.usedPercent,
            minutes: w.windowDurationMins,
            resetsAt: w.resetsAt
              ? new Date(w.resetsAt * 1000).toISOString()
              : null,
          })),
      })),
      models: ml.data
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.id,
          name: m.displayName,
          description: m.description,
          isDefault: m.isDefault,
          efforts: m.supportedReasoningEfforts.map((e) =>
            typeof e === "string" ? e : (e.reasoningEffort ?? ""),
          ),
          defaultEffort: m.defaultReasoningEffort,
        })),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
