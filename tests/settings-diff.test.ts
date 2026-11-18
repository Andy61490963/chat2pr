import { describe, expect, it } from "vitest";
import {
  describeChanges,
  egressResetRemovals,
  riskyChanges,
  settingsDiff,
} from "../shared/settings-diff.js";

const saved = {
  paused: false,
  triage_paused: false,
  auto_memory: true,
  code_downloads: true,
  group_replies: true,
  container_network: "isolated",
  rag_enabled: false,
  ai_mode: "subscription",
  daily_runs: 20,
  codex_model: null,
  triage_effort: "high",
  coding_effort: "medium",
  daily_budget: 5,
  task_budget: 3,
  task_minutes: 30,
  triage_model: "gpt-5.4-mini",
  coding_model: "gpt-6.1-sol",
} as const;

describe("工作流程設定的中文差異", () => {
  it("列出中文欄位名與值，沒改的欄位不列", () => {
    const changes = settingsDiff(saved, {
      ...saved,
      container_network: "open",
      ai_mode: "api",
      daily_budget: 10,
      coding_effort: "high",
    });
    expect(describeChanges(changes)).toBe(
      "容器網路：隔離 → 完全開放；AI 模式：ChatGPT 訂閱 → OpenAI API；開發與審查思考程度：中 → 高；每日額度：US$5 → US$10",
    );
  });
  it("開放容器網路與改用 API 標為有風險，並說明影響", () => {
    const risky = riskyChanges(
      settingsDiff(saved, {
        ...saved,
        container_network: "open",
        ai_mode: "api",
        daily_runs: 30,
      }),
    );
    expect(risky.map((c) => c.key)).toEqual(["container_network", "ai_mode"]);
    expect(risky[0].risk).toContain("公司內網");
    expect(risky[0].risk).toContain("正式資料庫");
    expect(risky[1].risk).toContain("依預估金額記帳");
    expect(risky[1].risk).toContain("每日與單次任務額度");
  });
  it("改回隔離、切回訂閱或只改其他欄位都不算有風險", () => {
    const open = { ...saved, container_network: "open", ai_mode: "api" };
    const back = settingsDiff(open, saved);
    expect(back.map((c) => c.key)).toEqual(["container_network", "ai_mode"]);
    expect(riskyChanges(back)).toEqual([]);
    expect(
      riskyChanges(
        settingsDiff(saved, { ...saved, paused: true, daily_runs: 5 }),
      ),
    ).toEqual([]);
  });
  it("舊資料沒有選填欄位時以實際預設比對，不誤報變更", () => {
    const legacy = {
      paused: true,
      ai_mode: "subscription",
      daily_runs: 20,
      daily_budget: 15,
    };
    expect(
      describeChanges(
        settingsDiff(legacy, {
          ...legacy,
          container_network: "isolated",
          code_downloads: true,
          group_replies: true,
          triage_paused: false,
        }),
      ),
    ).toBe("沒有變更");
    expect(
      describeChanges(
        settingsDiff(legacy, { ...legacy, container_network: "open" }),
      ),
    ).toBe("容器網路：隔離 → 完全開放");
    // 舊呼叫端省略的欄位視為不變。
    expect(settingsDiff(saved, { paused: true })).toEqual([
      { key: "paused", label: "派工", from: "自動派工", to: "已暫停" },
    ]);
  });
  it("只比對工作流程欄位：金鑰、LINE 使用者 ID 與白名單不會出現在差異裡", () => {
    const text = describeChanges(
      settingsDiff(
        {
          ...saved,
          admin_line_id: "U-fictional-old",
          egress_domains: ["a.test"],
        } as Record<string, unknown>,
        {
          ...saved,
          admin_line_id: "U-fictional-new",
          egress_domains: ["b.test"],
          openaiKey: "sk-fictional-key",
          lineToken: "fictional-line-token",
          codex_model: "gpt-fictional",
        } as Record<string, unknown>,
      ),
    );
    expect(text).toBe("Codex 模型：Codex 預設 → gpt-fictional");
    for (const secret of [
      "U-fictional",
      "a.test",
      "b.test",
      "sk-fictional",
      "fictional-line-token",
    ])
      expect(text).not.toContain(secret);
  });
});

describe("白名單還原預設會移除的網域", () => {
  it("列出目前清單中不在預設清單的網域（不分大小寫）", () => {
    expect(
      egressResetRemovals(
        [
          "registry.npmjs.org",
          "Packages.Fictional.test",
          ".nuget.org",
          "mirror.fictional.test",
        ],
        ["registry.npmjs.org", ".nuget.org", "packages.fictional.test"],
      ),
    ).toEqual(["mirror.fictional.test"]);
  });
  it("沒有預設清單資料時回 null，畫面改說會丟棄幾個自訂網域", () => {
    expect(egressResetRemovals(["mirror.fictional.test"], [])).toBeNull();
    expect(
      egressResetRemovals(["mirror.fictional.test"], undefined),
    ).toBeNull();
  });
});
