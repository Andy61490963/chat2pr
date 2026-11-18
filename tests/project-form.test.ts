import { describe, expect, it } from "vitest";
import {
  configChanged,
  offersValidation,
  portError,
  repoListStatus,
  saveProject,
  takenRepos,
  validateLabel,
  validationErrorParts,
  validationKind,
  type ProjectFormFields,
} from "../src/app/project-form.js";
import type { Project } from "../shared/types.js";
import { repoNotice, verificationLabel } from "../shared/project-setup.js";
import { prReport } from "../server/pr-body.js";
import { ConnectionBody } from "../server/project-database.js";

// 不需要資料庫：專案頁表單與狀態呈現的判斷規則。
const body = {
  engine: "sqlserver",
  host: "db.example.test",
  port: 1433,
  database: "mes",
  username: "schema_reader",
  password: "Fictional-Db-Pass-123",
};
const messages = (value: unknown) => {
  const result = ConnectionBody.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("資料庫連線表單的連接埠檢查", () => {
  it("空值不會被當成 0 送出，而是提示要填", () => {
    expect(portError("")).toBe("連接埠不可空白，請填 1–65535 的整數");
    expect(portError("  ", "SSH 連接埠")).toBe(
      "SSH 連接埠不可空白，請填 1–65535 的整數",
    );
  });
  it("超出範圍、小數或非數字都提示 1–65535 的整數", () => {
    for (const value of ["0", "65536", "14.33", "-1", "abc"])
      expect(portError(value)).toBe("連接埠請填 1–65535 的整數");
  });
  it("合法連接埠沒有提示", () => {
    expect(portError("1433")).toBe("");
    expect(portError("22", "SSH 連接埠")).toBe("");
    expect(portError("65535")).toBe("");
  });
});

describe("資料庫連線的伺服器檢查一律給中文訊息", () => {
  it("主機帶通訊協定時說明只能填主機名稱或 IP", () => {
    expect(messages({ ...body, host: "sqlserver://db:1433" })).toContain(
      "主機只能是主機名稱或 IP，不含通訊協定與路徑",
    );
  });
  it("連接埠為 0、空值或小數時回中文連接埠訊息", () => {
    expect(messages({ ...body, port: 0 })).toContain("連接埠請填 1–65535");
    expect(messages({ ...body, port: undefined })).toContain(
      "連接埠請填 1–65535 的數字",
    );
    expect(messages({ ...body, port: 14.5 })).toContain("連接埠請填整數");
  });
  it("SSH 底下的錯誤訊息前加「SSH 」，看得出是哪一塊", () => {
    const ssh = messages({
      ...body,
      ssh: { host: "ssh://jump", port: 70000, username: "deploy" },
    });
    expect(ssh).toContain("SSH 主機只能是主機名稱或 IP，不含通訊協定與路徑");
    expect(ssh).toContain("SSH 連接埠請填 1–65535");
  });
  it("長度與數量上限都有中文訊息", () => {
    expect(messages({ ...body, database: "x".repeat(129) })).toContain(
      "資料庫名稱最多 128 字",
    );
    expect(
      messages({
        ...body,
        referenceTables: Array.from({ length: 51 }, (_, i) => `dbo.T${i}`),
      }),
    ).toContain("參考資料表最多 50 個");
  });
  it("只有檢查規則本身沒有中文時才是英文（例如 engine），看板會略過不顯示", () => {
    const issues = messages({ ...body, engine: "postgres" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).not.toMatch(/[一-鿿]/);
  });
});

describe("驗證結果標示：資料庫結構由 AI 推測", () => {
  it("部分測試加推測結構：狀態與提醒都說出 AI 推測，並建議登記連線", () => {
    const label = verificationLabel({
      verification: "partial",
      dataSource: "inferred",
      limitations: "整合測試需要真實資料",
    });
    expect(label.status).toBe(
      "部分測試通過；AI 依環境限制縮小了測試範圍（資料庫結構由 AI 推測）",
    );
    expect(label.caution).toBe(
      "只執行了部分測試。未涵蓋：整合測試需要真實資料。測試用的資料庫結構由 AI 推測，登記資料庫連線並擷取結構快照可提高可信度。",
    );
  });
  it("只有建置加推測結構：狀態與提醒都說出 AI 推測", () => {
    const label = verificationLabel({
      verification: "build",
      dataSource: "inferred",
    });
    expect(label.status).toBe(
      "建置通過；未執行自動測試（資料庫結構由 AI 推測）",
    );
    expect(label.caution).toBe(
      "僅確認可建置，未執行自動測試。測試用的資料庫結構由 AI 推測，登記資料庫連線並擷取結構快照可提高可信度。",
    );
  });
  it("完整測試加推測結構維持原本文字；沒有推測時部分與建置也不變", () => {
    expect(
      verificationLabel({ verification: "tests", dataSource: "inferred" }),
    ).toEqual({
      status: "安裝與測試通過（資料庫結構由 AI 推測）",
      caution:
        "測試用的資料庫結構是 AI 從程式碼推測的，可能和真實資料庫不同。登記資料庫連線並擷取結構快照可提高可信度。",
    });
    expect(
      verificationLabel({ verification: "partial", limitations: "整合測試" }),
    ).toEqual({
      status: "部分測試通過；AI 依環境限制縮小了測試範圍",
      caution: "只執行了部分測試。未涵蓋：整合測試",
    });
    expect(verificationLabel({ verification: "build" }).status).toBe(
      "建置通過；未執行自動測試",
    );
  });
  it("PR 說明的驗證行同樣標出推測結構", () => {
    const pr = (o: Partial<Parameters<typeof prReport>[0]>) =>
      prReport({
        codexSummary: "調整報表",
        testCommand: "npm test",
        testOutput: "",
        ...o,
      });
    expect(
      pr({ verification: "partial", dataSource: "inferred", limitations: "x" }),
    ).toContain(
      "測試：部分通過；AI 依環境限制縮小了範圍，未涵蓋：x；資料庫結構由 AI 推測",
    );
    expect(pr({ verification: "build", dataSource: "inferred" })).toContain(
      "建置：通過；未執行自動測試；資料庫結構由 AI 推測",
    );
    expect(pr({ verification: "tests", dataSource: "inferred" })).toContain(
      "測試：通過；資料庫結構由 AI 從程式碼推測，可能和真實資料庫不同",
    );
    expect(pr({ verification: "partial", limitations: "x" })).not.toContain(
      "AI 推測",
    );
  });
});

describe("驗證失敗摘要的分段", () => {
  it("第一行是重點，錯誤重點收合，建議保持顯示", () => {
    expect(
      validationErrorParts(
        "安裝失敗（安裝階段）：套件裝不起來。\n錯誤重點：npm ERR! 404 fictional-pkg\n建議：依錯誤重點修正套件設定後重試。",
      ),
    ).toEqual({
      headline: "安裝失敗（安裝階段）：套件裝不起來。",
      body: [],
      detail: ["npm ERR! 404 fictional-pkg"],
      advice: ["建議：依錯誤重點修正套件設定後重試。"],
    });
  });
  it("錯誤重點跨多行時都收進同一段", () => {
    const parts = validationErrorParts(
      "測試失敗：有測試沒過。\n錯誤重點：第一行\n第二行\n建議：修正後重試。",
    );
    expect(parts.detail).toEqual(["第一行", "第二行"]);
    expect(parts.advice).toEqual(["建議：修正後重試。"]);
  });
  it("不是這個格式時照原文分行顯示，不收合任何內容", () => {
    expect(
      validationErrorParts("AppError: 部分測試沒有說明排除了什麼\n請重新驗證"),
    ).toEqual({
      headline: "AppError: 部分測試沒有說明排除了什麼",
      body: ["請重新驗證"],
      detail: [],
      advice: [],
    });
  });
});

describe("驗證失敗和其他提醒分開標示", () => {
  const project = {
    setup_input: null,
    repo_missing_at: null,
    validated_at: null,
    validation_error: null,
  } as unknown as Parameters<typeof validationKind>[0];
  it("沒有通過驗證且留有原因才是驗證失敗；從未驗證不是", () => {
    expect(validationKind(project)).toBeNull();
    expect(
      validationKind({
        ...project,
        validation_error: "測試失敗：有測試沒過。",
      }),
    ).toBe("failed");
  });
  it("已驗證的專案重新驗證遇到暫時性問題，維持原狀態只提醒", () => {
    expect(
      validationKind({
        ...project,
        validated_at: "2026-11-01T00:00:00Z",
        validation_error: "AI 服務暫時無法使用",
      } as typeof project),
    ).toBe("transient");
  });
  it("儲存庫接回後的「請重新驗證」不算驗證失敗", () => {
    for (const text of [repoNotice.found, repoNotice.changed])
      expect(validationKind({ ...project, validation_error: text })).toBe(
        "notice",
      );
  });
  it("等你回答與找不到儲存庫另有標示", () => {
    expect(
      validationKind({
        ...project,
        repo_missing_at: "2026-11-01T00:00:00Z",
        validation_error: "找不到儲存庫",
      } as typeof project),
    ).toBeNull();
  });
});

describe("選儲存庫時標出已加入的儲存庫", () => {
  const projects = [
    { id: "p1", repo: "Example-Org/Orders" },
    { id: "p2", repo: "example-org/billing" },
  ];
  it("不分大小寫比對其他專案使用中的儲存庫", () => {
    const taken = takenRepos(projects);
    expect(taken.has("example-org/orders")).toBe(true);
    expect(taken.has("example-org/billing")).toBe(true);
    expect(taken.has("example-org/new")).toBe(false);
  });
  it("排除正在編輯的這筆，找不到儲存庫的專案可以改選原本的位置", () => {
    expect(takenRepos(projects, "p1").has("example-org/orders")).toBe(false);
  });
});

describe("儲存庫清單的三種狀態", () => {
  it("讀取失敗時說出伺服器原因，不說成沒有安裝 App", () => {
    const s = repoListStatus(
      null,
      "服務暫時無法連線（HTTP 502），請稍後再試。",
    );
    expect(s.error).toBe(
      "無法取得儲存庫清單：服務暫時無法連線（HTTP 502），請稍後再試。",
    );
    expect(s.empty).toBe(false);
    expect(s.placeholder).toBe("無法取得儲存庫清單");
  });
  it("載入中不是空清單，也沒有錯誤", () => {
    expect(repoListStatus(null, "")).toEqual({
      placeholder: "載入中…",
      error: null,
      empty: false,
    });
  });
  it("成功但沒有儲存庫才提示去安裝 App", () => {
    expect(repoListStatus([], "").empty).toBe(true);
    expect(repoListStatus([{ full_name: "fictional-org/a" }], "").empty).toBe(
      false,
    );
  });
});

describe("存檔後接著驗證環境", () => {
  const project = (o: Partial<Project> = {}) =>
    ({
      id: "11111111-1111-4111-8111-111111111111",
      name: "虛構專案",
      repo: "fictional-org/orders",
      base_branch: "main",
      image: "line-agentflow-worker:local",
      setup_mode: "auto",
      sql_server: "auto",
      install_command: "",
      test_command: "",
      sensitive_paths: [],
      index_paths: [],
      setup_input: null,
      repo_missing_at: null,
      ...o,
    }) as Project;
  // 假的看板 request：記下呼叫順序，驗證 API 可以設定成失敗。
  const fake = (saved: Project, validateError?: string) => {
    const calls: string[] = [];
    const request = async <T>(url: string, method = "GET") => {
      calls.push(`${method} ${url}`);
      if (url.endsWith("/validate") && validateError)
        throw new Error(validateError);
      return (url.endsWith("/validate") ? { ok: true } : saved) as T;
    };
    return { calls, request };
  };
  const fields = (p: Project, o: Partial<ProjectFormFields> = {}) => ({
    repo: p.repo,
    base_branch: p.base_branch,
    image: p.image,
    setup_mode: p.setup_mode ?? "manual",
    sql_server: p.sql_server ?? "auto",
    install_command: p.install_command,
    test_command: p.test_command,
    sensitive_paths: p.sensitive_paths.join("\n"),
    index_paths: p.index_paths ?? [],
    ...o,
  });

  it("新增專案按「儲存並驗證環境」：先建立、再呼叫一次驗證，回傳 id 讓詳情打開", async () => {
    const saved = project();
    const { calls, request } = fake(saved);
    const result = await saveProject(request, undefined, {}, true);
    expect(calls).toEqual([
      "POST /api/projects",
      `POST /api/projects/${saved.id}/validate`,
    ]);
    expect(result.saved.id).toBe(saved.id);
    expect(result.notice).toEqual({
      text: "專案已儲存，已開始驗證環境，通過後會自動啟用派工",
    });
  });
  it("按「只儲存」：詳情照樣打開，但不呼叫驗證", async () => {
    const saved = project();
    const { calls, request } = fake(saved);
    const result = await saveProject(request, undefined, {}, false);
    expect(calls).toEqual(["POST /api/projects"]);
    expect(result.saved.id).toBe(saved.id);
    expect(result.notice.text).toBe("專案已儲存");
  });
  it("驗證排程失敗不算儲存失敗，提示原因與詳情裡的按鈕名稱", async () => {
    const saved = project();
    const { calls, request } = fake(saved, "工作佇列尚未啟動");
    const result = await saveProject(request, saved.id, {}, true);
    expect(calls).toEqual([
      `PUT /api/projects/${saved.id}`,
      `POST /api/projects/${saved.id}/validate`,
    ]);
    expect(result.notice).toEqual({
      error: true,
      text: "專案已儲存，但驗證沒有排上：工作佇列尚未啟動，可在詳情按「AI 自動設定並驗證」重試",
    });
    expect(
      (
        await saveProject(
          fake(project({ setup_mode: "manual" }), "服務暫時無法連線。").request,
          saved.id,
          {},
          true,
        )
      ).notice.text,
    ).toBe(
      "專案已儲存，但驗證沒有排上：服務暫時無法連線，可在詳情按「驗證環境」重試",
    );
  });
  it("存檔本身失敗時丟出錯誤，不呼叫驗證", async () => {
    const calls: string[] = [];
    const request = async <T>(url: string, method = "GET"): Promise<T> => {
      calls.push(`${method} ${url}`);
      throw new Error("已經有專案「虛構專案」使用這個儲存庫");
    };
    await expect(saveProject(request, undefined, {}, true)).rejects.toThrow(
      "已經有專案「虛構專案」使用這個儲存庫",
    );
    expect(calls).toEqual(["POST /api/projects"]);
  });
  it("找不到儲存庫或等你回答的專案不自動驗證", async () => {
    for (const saved of [
      project({ repo_missing_at: "2026-11-01T00:00:00Z" }),
      project({ setup_input: { question: "要用哪個測試命令？" } as never }),
    ]) {
      const { calls, request } = fake(saved);
      const result = await saveProject(request, saved.id, {}, true);
      expect(calls).toEqual([`PUT /api/projects/${saved.id}`]);
      expect(result.notice.error).toBeUndefined();
      expect(result.notice.text).toMatch(/^專案已儲存；/);
    }
  });
  it("新增專案一律提供「儲存並驗證環境」", () => {
    const blank = { repo: "", name: "" } as Partial<Project>;
    expect(offersValidation(blank, fields(project(), { repo: "x/y" }))).toBe(
      true,
    );
  });
  it("只改名稱或說明不提供驗證；改基底分支、映像或指令才提供", () => {
    const p = project();
    // 表單欄位裡沒有名稱與說明：它們不影響驗證。
    expect(configChanged(p, fields(p))).toBe(false);
    expect(offersValidation(p, fields(p))).toBe(false);
    for (const change of [
      { base_branch: "develop" },
      { image: "fictional-image:dev" },
      { test_command: "npm test" },
      { install_command: "npm ci" },
      { setup_mode: "manual" },
      { sensitive_paths: "src/auth/" },
      { index_paths: ["docs"] },
    ])
      expect(offersValidation(p, fields(p, change))).toBe(true);
  });
  it("詳情按鈕的名稱依狀態：找不到儲存庫是重新檢查", () => {
    expect(
      validateLabel({ repo_missing_at: "2026-11-01", setup_mode: "auto" }),
    ).toBe("重新檢查");
    expect(validateLabel({ repo_missing_at: null, setup_mode: "auto" })).toBe(
      "AI 自動設定並驗證",
    );
    expect(validateLabel({ repo_missing_at: null, setup_mode: "manual" })).toBe(
      "驗證環境",
    );
  });
});
