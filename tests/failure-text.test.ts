import { describe, expect, it } from "vitest";
import {
  categoryLabels,
  classifyFailure,
  failureNotice,
} from "../server/failure.js";
import {
  failureBrief,
  failureLabels,
  fixFirst,
  fixPage,
  parseFailure,
  primaryFix,
  waitHint,
} from "../shared/failure-text.js";

// 看板把 failureNotice 的輸出拆成白話說明、建議與錯誤重點；兩邊格式必須一致（docs/conventions.md 第 3 節）。
describe("parseFailure 拆解 failureNotice 的實際輸出", () => {
  it("分類標籤與伺服器的 categoryLabels 相同", () => {
    expect(failureLabels).toEqual(categoryLabels);
  });

  const samples: [string, string, string][] = [
    ["config", "尚未登記資料庫連線：虛構專案 demo-shop", "code"],
    [
      "environment",
      "測試環境問題：SQL Server 容器沒有在 60 秒內就緒\nlogin failed for sa",
      "test",
    ],
    [
      "project",
      "目標分支基底驗證失敗：npm test 退出碼 1\nFAIL tests/cart.test.ts",
      "base",
    ],
    ["transient", "執行器連線失敗：socket hang up", "code"],
    ["system", "TypeError: 虛構的預期外錯誤", "code"],
  ];
  for (const [category, raw, phase] of samples)
    it(`${category}：取出分類、白話說明、建議與錯誤重點`, () => {
      const f = classifyFailure(raw, phase);
      expect(f.category).toBe(category);
      for (const where of ["", "測試"]) {
        const parsed = parseFailure(failureNotice(f, false, where));
        expect(parsed).not.toBeNull();
        expect(parsed!.category).toBe(category);
        expect(parsed!.plain).toBe(f.plain);
        expect(parsed!.action).toBe(f.action);
        expect(parsed!.detail).toBe(
          f.detail ||
            (category === "environment"
              ? "工具沒有留下錯誤訊息，完整輸出見執行紀錄"
              : ""),
        );
        expect(parsed!.headline.startsWith(categoryLabels[f.category])).toBe(
          true,
        );
        if (where) expect(parsed!.headline).toContain("（測試階段）");
      }
    });

  it("多行錯誤重點整段保留，建議不會被錯誤重點吞掉", () => {
    const f = classifyFailure(
      "一次自動修復後仍未通過驗證\n第一行審查意見\n第二行審查意見",
      "verify",
    );
    const parsed = parseFailure(failureNotice(f));
    expect(parsed?.category).toBe("project");
    expect(parsed?.detail).toContain("第一行審查意見\n第二行審查意見");
    expect(parsed?.action).toBe(f.action);
  });

  it("已自動重試的說明留在白話說明裡", () => {
    const f = classifyFailure("執行器連線失敗：socket hang up", "code");
    const parsed = parseFailure(`Error: ${failureNotice(f, true)}`);
    expect(parsed?.category).toBe("transient");
    expect(parsed?.plain).toBe(`${f.plain}（已自動重試一次，仍然失敗）`);
  });

  it("舊格式或不是失敗說明時回傳 null", () => {
    for (const text of [
      null,
      undefined,
      "",
      "Codex 執行失敗：stream disconnected",
      "AI 等你回答：要改哪一個頁面？",
      "測試失敗\n建議：重試",
      "設定問題：缺少設定。\n其他段落：x\n建議：補上設定。",
    ])
      expect(parseFailure(text)).toBeNull();
  });

  it("failureBrief：可解析時是白話說明，否則取第一行", () => {
    const f = classifyFailure("尚未登記資料庫連線", "code");
    expect(failureBrief(failureNotice(f))).toBe(f.plain);
    expect(failureBrief("Error: 舊的錯誤\n第二行")).toBe("舊的錯誤");
    expect(failureBrief(null)).toBe("");
  });
});

describe("失敗卡片的主按鈕與前往頁面", () => {
  it("設定、環境、專案類先處理再重試；暫時性、系統與無法解析時維持重試", () => {
    expect(fixFirst("config")).toBe(true);
    expect(fixFirst("environment")).toBe(true);
    expect(fixFirst("project")).toBe(true);
    expect(fixFirst("transient")).toBe(false);
    expect(fixFirst("system")).toBe(false);
    expect(fixFirst(undefined)).toBe(false);
  });

  it("建議指向專案頁時前往專案設定，指向設定頁時前往設定", () => {
    const missing = classifyFailure("尚未登記資料庫連線", "code");
    expect(missing.category).toBe("config");
    expect(fixPage(parseFailure(failureNotice(missing))?.action)).toBe(
      "projects",
    );
    const quota = classifyFailure("今日執行次數已達上限", "code");
    expect(quota.category).toBe("config");
    expect(fixPage(parseFailure(failureNotice(quota))?.action)).toBe(
      "settings",
    );
    // 登入或權限問題在多個地方處理，不猜要去哪一頁。
    const denied = classifyFailure("Bad credentials", "code");
    expect(fixPage(parseFailure(failureNotice(denied))?.action)).toBeNull();
  });

  it("同時提到多個頁面時取最先提到的", () => {
    expect(
      fixPage("請管理者到「系統 → 下載來源白名單」確認，或到專案頁重新規劃"),
    ).toBe("system");
    expect(fixPage("到群組頁重新啟用")).toBe("groups");
    expect(fixPage("記憶體回升後自動繼續，不用重新提出")).toBeNull();
    expect(fixPage(null)).toBeNull();
  });
});

// 收件匣卡片與任務詳情共用 primaryFix 決定主按鈕；輸入用 failureNotice 的實際輸出。
describe("primaryFix：失敗主按鈕依原因調整", () => {
  const notice = (raw: string, phase = "code", retried = false) =>
    parseFailure(failureNotice(classifyFailure(raw, phase), retried));

  it("執行期間設定被變更：分類是設定問題，但主按鈕仍是重試", () => {
    for (const raw of ["需求版本已改變", "專案設定已變更", "群組已停用"]) {
      const parsed = notice(raw);
      expect(parsed?.category).toBe("config");
      expect(parsed?.plain).toContain("設定被變更");
      expect(primaryFix(parsed)).toEqual({ kind: "retry" });
    }
  });

  it("逾時時主按鈕是修改這一題，不是前往設定", () => {
    for (const [raw, retried] of [
      ["Codex 執行超過 30 分鐘限制", false],
      ["訂閱階段已超過期限", true],
    ] as const) {
      const parsed = notice(raw, "code", retried);
      expect(parsed?.plain).toContain("時間限制");
      // 建議文字提到「設定」，舊規則會把主按鈕變成「前往設定」。
      expect(fixPage(parsed?.action)).toBe("settings");
      expect(primaryFix(parsed)).toEqual({ kind: "amend" });
    }
  });

  it("逾時前修改已保留：主按鈕是重試，不建議縮小需求範圍", () => {
    const parsed = notice("修改已保留，執行超過時間限制", "review");
    expect(parsed?.plain).toContain("修改已保留");
    expect(parsed?.action).toContain("從測試與獨立審查接續");
    expect(parsed?.action).not.toContain("縮小需求範圍");
    expect(primaryFix(parsed)).toEqual({ kind: "retry" });
  });

  it("修復途中逾時：說明保留的是修改與審查意見，重試直接修復", () => {
    const parsed = notice("修改與審查意見已保留，執行超過時間限制", "code");
    expect(parsed?.plain).toContain("驗證沒有通過");
    expect(parsed?.action).toContain("自動修復");
    expect(parsed?.action).not.toContain("從測試與獨立審查接續");
    expect(primaryFix(parsed)).toEqual({ kind: "retry" });
  });

  it("缺少連線：前往專案設定", () => {
    expect(
      primaryFix(notice("尚未登記資料庫連線：虛構專案 demo-shop")),
    ).toEqual({ kind: "page", page: "projects" });
  });

  it("額度不足前往設定；權限問題沒有指向頁面時看詳情；暫時性與無法解析時重試", () => {
    expect(primaryFix(notice("今日執行次數已達上限"))).toEqual({
      kind: "page",
      page: "settings",
    });
    expect(primaryFix(notice("Bad credentials"))).toEqual({ kind: "detail" });
    expect(primaryFix(notice("執行器連線失敗：socket hang up"))).toEqual({
      kind: "retry",
    });
    expect(primaryFix(notice("TypeError: 虛構的預期外錯誤"))).toEqual({
      kind: "retry",
    });
    expect(primaryFix(parseFailure("Codex 執行失敗：舊格式"))).toEqual({
      kind: "retry",
    });
  });
});

describe("waitHint：等待額度的恢復說明", () => {
  it("今日執行次數用完：臺北午夜後或提高每日次數後自動繼續", () => {
    for (const mode of ["api", "subscription"] as const)
      expect(waitHint("今日執行次數已達上限，工作已保留", mode)).toContain(
        "臺北時間午夜後",
      );
  });
  it("API 模式預估額度：隔日自動繼續", () => {
    expect(waitHint("今日預估額度不足，工作已保留", "api")).toContain("隔日");
  });
  it("Codex 訂閱額度：恢復後自動繼續", () => {
    expect(waitHint("Codex 訂閱額度已達上限", "subscription")).toContain(
      "額度恢復後自動繼續",
    );
    expect(waitHint(null, "subscription")).toContain("訂閱額度");
  });
  it("查不到訂閱額度時不說額度已用完", () => {
    const hint = waitHint(
      "無法確認 Codex 訂閱額度，已保留訊息與工作；稍後重新檢查",
      "subscription",
    );
    expect(hint).toContain("暫時無法確認");
    expect(hint).not.toContain("已達上限");
  });
});
