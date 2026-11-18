import type { Settings } from "./types.js";

/**
 * 工作流程設定（`PUT /api/settings`）的中文差異，看板確認對話框與稽核共用。
 * 只比對下面列出的欄位：都是一般設定值，不含金鑰或 LINE 使用者 ID；
 * 不在清單裡的欄位（例如 admin_line_id、egress_domains）一律不列，免得寫進活動紀錄。
 */
type Field = {
  label: string;
  /** 舊資料沒有這個欄位時的實際行為，與看板 pickSettings 相同。 */
  fallback?: unknown;
  value?: (v: unknown) => string;
};

const onOff = (v: unknown) => (v ? "開啟" : "關閉");
const effort: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "極致",
};

const fields = {
  paused: {
    label: "派工",
    fallback: false,
    value: (v) => (v ? "已暫停" : "自動派工"),
  },
  triage_paused: {
    label: "新需求判讀",
    fallback: false,
    value: (v) => (v ? "已暫停" : "照常"),
  },
  auto_memory: { label: "自動歸納群組記憶", fallback: true, value: onOff },
  code_downloads: { label: "開發時允許下載套件", fallback: true, value: onOff },
  group_replies: { label: "在群組回覆", fallback: true, value: onOff },
  container_network: {
    label: "容器網路",
    fallback: "isolated",
    value: (v) => (v === "open" ? "完全開放" : "隔離"),
  },
  rag_enabled: { label: "本機 RAG", fallback: false, value: onOff },
  ai_mode: {
    label: "AI 模式",
    value: (v) =>
      v === "api" ? "OpenAI API" : v === "subscription" ? "ChatGPT 訂閱" : "",
  },
  daily_runs: { label: "每日最多執行次數" },
  codex_model: {
    label: "Codex 模型",
    fallback: null,
    value: (v) => (typeof v === "string" && v ? v : "Codex 預設"),
  },
  triage_effort: {
    label: "需求判讀思考程度",
    value: (v) => effort[String(v)] ?? String(v),
  },
  coding_effort: {
    label: "開發與審查思考程度",
    value: (v) => effort[String(v)] ?? String(v),
  },
  daily_budget: {
    label: "每日額度",
    value: (v) => `US$${String(v)}`,
  },
  task_budget: {
    label: "單次任務額度",
    value: (v) => `US$${String(v)}`,
  },
  task_minutes: {
    label: "每個任務時間上限",
    value: (v) => `${String(v)} 分鐘`,
  },
  triage_model: { label: "需求辨識模型" },
  coding_model: { label: "程式開發模型" },
} satisfies Partial<Record<keyof Settings, Field>>;

export type SettingsKey = keyof typeof fields;
export type SettingsValues = Partial<Record<SettingsKey, unknown>>;

export interface SettingsChange {
  key: SettingsKey;
  label: string;
  from: string;
  to: string;
  /** 有風險的變更才有：說明生效後會發生什麼，確認對話框照列。 */
  risk?: string;
}

const risks: Partial<
  Record<SettingsKey, { from: unknown; to: unknown; text: string }>
> = {
  container_network: {
    from: "isolated",
    to: "open",
    text: "開發、測試與審查容器可直接連網際網路與公司內網，包含專案設定檔中的正式資料庫；群組訊息若誤導 AI，也可能直接改動這些系統。",
  },
  ai_mode: {
    from: "subscription",
    to: "api",
    text: "之後的判讀與開發改用 OpenAI API 金鑰，依預估金額記帳並開始計費，受每日與單次任務額度限制。",
  },
};

const show = (field: Field, v: unknown) => {
  if (v === undefined) return "未設定";
  const text = field.value ? field.value(v) : String(v ?? "");
  return text || "未設定";
};

/** 依欄位順序列出有改的設定；沒出現在 after 的欄位視為不變（舊呼叫端可省略選填欄位）。 */
export function settingsDiff(
  before: SettingsValues,
  after: SettingsValues,
): SettingsChange[] {
  const changes: SettingsChange[] = [];
  for (const key of Object.keys(fields) as SettingsKey[]) {
    if (!(key in after) || after[key] === undefined) continue;
    const field: Field = fields[key];
    const was = before[key] ?? field.fallback;
    const now = after[key];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const risk = risks[key];
    changes.push({
      key,
      label: field.label,
      from: show(field, was),
      to: show(field, now),
      ...(risk && was === risk.from && now === risk.to
        ? { risk: risk.text }
        : {}),
    });
  }
  return changes;
}

/** 需要先確認才儲存的變更：容器網路改成完全開放、AI 模式從訂閱改成 API。 */
export const riskyChanges = (changes: SettingsChange[]) =>
  changes.filter((c) => c.risk);

/** 「容器網路：隔離 → 完全開放；每日額度：US$5 → US$10」；沒有變更時回「沒有變更」。 */
export function describeChanges(changes: SettingsChange[]) {
  return changes.length
    ? changes.map((c) => `${c.label}：${c.from} → ${c.to}`).join("；")
    : "沒有變更";
}

/**
 * 白名單「還原預設」會丟掉的網域：目前清單中不在預設清單的。
 * 拿不到預設清單時回 null，畫面改說「會丟棄目前 N 個自訂網域」。
 */
export function egressResetRemovals(
  domains: string[],
  defaults: string[] | undefined,
): string[] | null {
  if (!defaults?.length) return null;
  const keep = new Set(defaults.map((d) => d.toLowerCase()));
  return domains.filter((d) => !keep.has(d.toLowerCase()));
}
