import { expect, test } from "@playwright/test";
import type { Detail } from "../src/app/shared";
import type { Task } from "../shared/types";
import {
  defaultState,
  detail,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

test("任務詳情顯示排隊原因與失敗後的處理建議", async ({ page }) => {
  const queued: Task = { ...task, title: "整理範例清單", status: "queued" };
  const failed: Task = {
    ...task,
    id: "22222222-2222-4222-8222-222222222222",
    title: "檢查範例專案",
    status: "failed",
    last_error: "設定問題：找不到測試指令。\n建議：請到專案頁補上測試指令。",
  };
  const queuedDetail: Detail = {
    ...detail,
    task: queued,
    queue: {
      code: "waiting",
      position: 2,
      text: "工作名額已滿，等待空位",
      hint: null,
      retry_at: null,
    },
  };
  await mockDashboard(page, {
    state: { tasks: [queued, failed] },
    routes: {
      [`/api/tasks/${queued.id}`]: queuedDetail,
      [`/api/tasks/${failed.id}`]: { ...detail, task: failed, queue: null },
    },
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: /整理範例清單/ }).click();
  const queuedDrawer = page.getByRole("dialog", { name: queued.title });
  await expect(
    queuedDrawer.getByRole("status", { name: "排隊原因" }),
  ).toContainText("排隊中（第 2 位）：工作名額已滿，等待空位");
  await queuedDrawer.getByRole("button", { name: "關閉", exact: true }).click();
  await page.getByRole("button", { name: /檢查範例專案/ }).click();
  const failedDrawer = page.getByRole("dialog", { name: failed.title });
  await expect(
    failedDrawer.getByText(/建議：請到專案頁補上測試指令/),
  ).toBeVisible();
  await expect(
    failedDrawer.getByRole("button", { name: "重試" }),
  ).toBeVisible();
  await expect(
    failedDrawer.getByRole("button", { name: "結束任務" }),
  ).toBeVisible();
  // 設定類失敗先去修設定，重試再試一次只會再失敗，所以前往設定是主按鈕。
  await expect(
    failedDrawer.getByRole("button", { name: "前往專案設定" }),
  ).toBeVisible();
});

test("補問回答遇到版本衝突時保留已輸入的文字", async ({ page }) => {
  const pending: Task = {
    ...task,
    status: "awaiting_approval",
    question: { text: "要整理哪個月份的清單？", choices: [] },
  };
  await mockDashboard(page, {
    state: { tasks: [pending] },
    routes: { [`/api/tasks/${pending.id}`]: { ...detail, task: pending } },
  });
  const conflict = "任務版本已更新，請再確認一次。";
  const answerPath = `/api/tasks/${pending.id}/answer`;
  await page.route(`**${answerPath}`, (route) =>
    route.fulfill({ status: 409, json: { error: conflict } }),
  );
  await page.goto(`/tasks?task=${pending.id}`);
  const answer = page.getByRole("textbox", { name: "回答這個問題" });
  const draft = "請整理十月份的清單。";
  await answer.fill(draft);
  const response = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === answerPath &&
      res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "送出回答" }).click();
  const result = await response;
  expect(result.status()).toBe(409);
  expect(result.request().postDataJSON()).toMatchObject({
    text: draft,
    version: pending.version,
  });
  await expect(page.getByText(conflict, { exact: true })).toBeVisible();
  await expect(answer).toHaveValue(draft);
});

test("通知鈴鐺可用鍵盤開關選單、移動焦點並前往對應頁面", async ({ page }) => {
  const notice = {
    id: "notice-project",
    task_id: null,
    kind: "repo_found",
    title: "範例專案已恢復",
    text: "可以繼續處理需求",
    created_at: "2026-01-01T08:00:00Z",
  };
  const service = {
    ...notice,
    id: "notice-service",
    kind: "service_up",
    title: "範例服務已恢復",
  };
  await mockDashboard(page, {
    state: { alerts: [notice, service], alertsSeenAt: null },
  });
  await page.goto("/");
  const bell = page.getByRole("button", { name: /^通知(?:，|$)/ });
  await bell.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(bell).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // 桌面通知開關依瀏覽器支援與否出現在最前面，從最後一則通知開始移動。
  await page.keyboard.press("End");
  const last = menu.getByRole("menuitem", { name: /範例服務已恢復/ });
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    menu.getByRole("menuitem", { name: /範例專案已恢復/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "設定", exact: true }),
  ).toBeVisible();
  await expect(menu).toBeHidden();
});

test("取消所有專案開放網路（不建議）的確認對話框後不送出設定", async ({
  page,
}) => {
  await mockDashboard(page);
  const updates: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/settings"
    ) {
      updates.push(request.url());
    }
  });
  await page.goto("/settings");
  const network = page.getByRole("switch", {
    name: "所有專案開放網路（不建議）",
  });
  await expect(network).not.toBeChecked();
  await network.click();
  await page.getByRole("button", { name: "儲存設定" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "確定要套用這些變更？",
  });
  await expect(
    confirmation.getByText("容器網路：隔離 → 完全開放"),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "先不要" }).click();
  await expect(confirmation).toBeHidden();
  await expect(network).toBeChecked();
  await expect(page.getByText("有修改尚未儲存", { exact: true })).toBeVisible();
  expect(updates).toHaveLength(0);
});

test("專案的完全存取要先確認才開啟，取消不送出", async ({ page }) => {
  await mockDashboard(page);
  const bodies: unknown[] = [];
  await page.route("**/api/projects/project-demo/full-access", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: "project-demo", full_access: true },
    });
  });
  await page.goto("/projects");
  await page.getByText("測試專案", { exact: true }).first().click();
  await page.getByRole("tab", { name: "連線與權限" }).click();
  const section = page.getByRole("region", { name: "完全存取" });
  await expect(section.getByText("關閉", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "開啟完全存取" }).click();
  const dialog = page.getByRole("dialog", {
    name: "開啟「測試專案」的完全存取？",
  });
  await expect(dialog).toContainText("帳號能寫入，AI 就可能寫入");
  await dialog.getByRole("button", { name: "先不要" }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(0);
  await section.getByRole("button", { name: "開啟完全存取" }).click();
  await dialog.getByRole("button", { name: "開啟完全存取" }).click();
  await expect.poll(() => bodies).toEqual([{ enabled: true }]);
});

test("用白話描述資料庫連線，AI 整理後填進欄位並列出連不到的位址", async ({
  page,
}) => {
  await mockDashboard(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["PUT", "DELETE"].includes(request.method()))
      writes.push(request.url());
  });
  await page.route("**/api/projects/project-demo/database/extract", (route) =>
    route.fulfill({
      json: {
        connection: {
          host: "100.64.0.10",
          port: 1433,
          database: "MES_TEST",
          username: "mes_reader",
          password: "fictional-pass",
          encrypt: null,
          trustServerCertificate: null,
          ssh: null,
        },
        endpoints: [
          {
            host: "100.64.0.10",
            port: 1433,
            purpose: "資料庫",
            reachable: true,
            detail: "連得到（12 ms）",
          },
          {
            host: "10.3.1.7",
            port: 8096,
            purpose: "廠內看板",
            reachable: false,
            detail: "5 秒內沒有回應",
          },
        ],
        vpn: { needed: true, note: "要先連公司 VPN 才到得了 10.3.1.x。" },
        notes: [],
      },
    }),
  );
  await page.goto("/projects");
  await page.getByText("測試專案", { exact: true }).first().click();
  await page.getByRole("tab", { name: "連線與權限" }).click();
  const describe = page.getByLabel("用白話描述連線");
  await describe.fill(
    "MES 測試庫在 100.64.0.10，帳號 mes_reader 密碼 fictional-pass",
  );
  await page.getByRole("button", { name: "交給 AI 整理" }).click();
  await expect(page.getByLabel("主機", { exact: true })).toHaveValue(
    "100.64.0.10",
  );
  await expect(page.getByLabel("資料庫名稱")).toHaveValue("MES_TEST");
  await expect(page.getByLabel("帳號", { exact: true })).toHaveValue(
    "mes_reader",
  );
  await expect(page.getByLabel("密碼", { exact: true })).toHaveValue(
    "fictional-pass",
  );
  await expect(page.getByText(/廠內看板：10\.3\.1\.7:8096/)).toBeVisible();
  await expect(page.getByText(/要先連公司 VPN/)).toBeVisible();
  // 原文清掉，也不會自動儲存。
  await expect(describe).toHaveValue("");
  expect(writes).toHaveLength(0);
});

test("登記 SSH 主機：密碼只送出不顯示，測試登入顯示結果", async ({ page }) => {
  await mockDashboard(page);
  const posts: unknown[] = [];
  const host = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "jet-u01",
    host: "10.0.7.31",
    port: 22,
    username: "reader",
    auth: "password",
    note: "U01 工控電腦",
    hostKey: null,
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
  await page.route("**/api/projects/project-demo/ssh-hosts", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: posts.length ? [host] : [] });
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: [host] });
  });
  await page.route(
    `**/api/projects/project-demo/ssh-hosts/${host.id}/test`,
    (route) => route.fulfill({ json: { ok: true, detail: "登入成功" } }),
  );
  await page.goto("/projects");
  await page.getByText("測試專案", { exact: true }).first().click();
  await page.getByRole("tab", { name: "連線與權限" }).click();
  const section = page.getByRole("region", { name: "SSH 主機" });
  await expect(section).toContainText("沒有開啟完全存取");
  await section.getByRole("button", { name: "新增 SSH 主機" }).click();
  await section.getByRole("button", { name: "儲存" }).click();
  await expect(section.getByRole("alert")).toContainText("名稱只能用英數字");
  expect(posts).toHaveLength(0);
  await section.getByLabel("名稱").fill("jet-u01");
  await section.getByLabel("SSH 主機位址").fill("10.0.7.31");
  await section.getByLabel("登入帳號").fill("reader");
  await section.getByLabel("登入密碼").fill("fictional-ssh-pass");
  await section.getByLabel(/用途說明/).fill("U01 工控電腦");
  await section.getByRole("button", { name: "儲存" }).click();
  await expect
    .poll(() => posts)
    .toEqual([
      {
        name: "jet-u01",
        host: "10.0.7.31",
        port: 22,
        username: "reader",
        note: "U01 工控電腦",
        password: "fictional-ssh-pass",
      },
    ]);
  await expect(section.getByText("reader@10.0.7.31:22")).toBeVisible();
  await expect(section.getByText("還沒測試登入")).toBeVisible();
  await expect(section.getByText("fictional-ssh-pass")).toHaveCount(0);
  await section.getByRole("button", { name: "測試登入" }).click();
  await expect(section.getByRole("status")).toHaveText("登入成功");
});

test("你能在任務詳情追查查詢版本，閱讀答案時只看到報告", async ({ page }) => {
  const version = "a".repeat(40);
  const completed = {
    ...task,
    status: "answered" as const,
    answer: "## 先看重點\n範例結論。",
    base_sha: version,
  };
  await mockDashboard(page, {
    state: { tasks: [completed] },
    routes: {
      [`/api/tasks/${task.id}`]: {
        ...detail,
        task: completed,
        runs: [
          {
            id: "run-demo",
            version: task.version,
            threads: [],
            status: "done",
            query_sources: [
              {
                name: "範例來源",
                repo: "demo/source",
                branch: "example",
                commit: version,
              },
            ],
          },
        ],
      },
    },
  });
  await page.goto(`/tasks?task=${task.id}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("範例結論。")).toBeVisible();
  await dialog.getByText("查詢時的專案、分支與版本").click();
  await expect(dialog.getByText(version, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/範例來源（demo\/source）/)).toBeVisible();
});

test("你能在已回覆的修改任務查看無需修改的原因", async ({ page }) => {
  const conclusion = "已經符合需求，沒有需要修改的地方。";
  const explanation = "範例按鈕已使用綠色，現有測試涵蓋此條件。";
  const completed: Task = {
    ...task,
    mode: "change",
    status: "answered",
    answer: `${conclusion}\n\n${explanation}`,
  };
  await mockDashboard(page, {
    state: { tasks: [completed] },
    routes: { [`/api/tasks/${task.id}`]: { ...detail, task: completed } },
  });
  await page.goto(`/tasks?task=${task.id}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("已回覆").first()).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "修改結果" })).toBeVisible();
  await expect(dialog.getByText(conclusion)).toBeVisible();
  await expect(dialog.getByText(explanation)).toBeVisible();
  await expect(dialog.getByRole("link", { name: /開啟 PR/ })).toHaveCount(0);
});

for (const progress of [
  "你的專案正在排隊等待執行器。",
  "你的專案正在等待上一次驗證釋放執行環境。",
  "你的專案正在安裝相依套件。",
  "你的專案正在執行基底測試。",
  "你的專案正在進行第 2 次 AI 調整。",
]) {
  test(`專案列表與詳情顯示驗證階段「${progress}」`, async ({ page }) => {
    await mockDashboard(page, {
      state: { projects: [{ ...project, validation_progress: progress }] },
    });
    await page.goto("/projects");
    const row = page.getByRole("button", { name: /^測試專案/ });
    await expect(row.getByText("驗證中", { exact: true })).toBeVisible();
    await expect(row.getByText(progress, { exact: true })).toBeVisible();
    await row.click();
    const dialog = page.getByRole("dialog", { name: project.name });
    await expect(dialog.getByText("驗證中", { exact: true })).toBeVisible();
    const status = dialog.getByRole("status").filter({ hasText: progress });
    await expect(status).toBeVisible();
    await dialog.getByRole("tab", { name: "環境驗證" }).click();
    await expect(status).toBeVisible();
  });
}

test("再次按驗證時，看板顯示已在驗證中", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      projects: [
        { ...project, validation_progress: "你的專案正在安裝相依套件。" },
      ],
    },
  });
  await page.route(`**/api/projects/${project.id}/validate`, (route) =>
    route.fulfill({ status: 202, json: { ok: true, message: "已在驗證中" } }),
  );
  await page.goto("/projects");
  await page.getByRole("button", { name: /^測試專案/ }).click();
  const dialog = page.getByRole("dialog", { name: project.name });
  await dialog.getByRole("button", { name: "驗證環境" }).click();
  await expect(page.getByText("已在驗證中", { exact: true })).toBeVisible();
});

test("專案補問通知直接開啟環境驗證，方向鍵可切換其他分頁", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      alerts: [
        {
          id: "notice-input",
          task_id: null,
          project_id: "project-demo",
          kind: "project_input",
          title: null,
          text: "請補充範例資訊",
          created_at: "2026-01-01T08:00:00Z",
        },
      ],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^通知(?:，|$)/ }).click();
  await page.getByRole("menuitem", { name: /請補充範例資訊/ }).click();
  const dialog = page.getByRole("dialog", { name: "測試專案" });
  const environment = dialog.getByRole("tab", { name: /環境驗證/ });
  await expect(environment).toHaveAttribute("aria-selected", "true");
  await environment.focus();
  for (const name of ["連線與權限", "記憶", "概況"]) {
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("tab", { name })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
});

test("LINE 的專案連結直接開啟對應專案與分頁", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/projects?project=project-demo&tab=environment");
  await expect(
    page
      .getByRole("dialog", { name: "測試專案" })
      .getByRole("tab", { name: /環境驗證/ }),
  ).toHaveAttribute("aria-selected", "true");
});

test("群組總開關關閉時能直接前往設定查看實際回覆數", async ({ page }) => {
  await mockDashboard(page, {
    state: { settings: { ...defaultState.settings, group_replies: false } },
  });
  await page.goto("/groups");
  await page.getByRole("button", { name: /測試群組/ }).click();
  const status = page
    .getByRole("status")
    .filter({ hasText: "設定頁的總開關已關閉" });
  await expect(status).toBeVisible();
  await status.getByRole("button", { name: "前往設定" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#group-replies-hint")).toContainText(
    "0 個群組會回覆",
  );
});

test("設定優先列出異常，正常的檢索服務收在全部服務", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      health: [
        {
          name: "github",
          ok: false,
          detail: "範例連線失敗",
          checked_at: new Date().toISOString(),
        },
        {
          name: "rag_index",
          ok: true,
          detail: "範例索引正常",
          checked_at: new Date().toISOString(),
        },
      ],
    },
  });
  await page.goto("/settings");
  await expect(
    page.getByRole("listitem").filter({ hasText: "範例連線失敗" }).first(),
  ).toBeVisible();
  const services = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "全部服務" }) });
  await expect(
    services.getByRole("listitem").filter({ hasText: "範例索引正常" }),
  ).toBeHidden();
  await services.locator("summary").click();
  await expect(
    services.getByRole("listitem").filter({ hasText: "範例索引正常" }),
  ).toBeVisible();
});
test("群組可查看記憶總覽，第一版任務隱藏版號", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/groups");
  await expect(page.getByText("記憶總覽", { exact: true })).toBeVisible();
  await page.goto("/tasks");
  await page.getByRole("button", { name: new RegExp(task.title) }).click();
  await expect(
    page.getByRole("dialog").getByText("版本 1", { exact: true }),
  ).toHaveCount(0);
});
