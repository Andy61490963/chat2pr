import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Alert } from "../src/app/alerts";
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
    disposition: "result",
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
  await expect(page).toHaveURL("/settings?tab=connections");
  await expect(
    page.getByRole("heading", { name: "設定", exact: true }),
  ).toBeVisible();
  await expect(menu).toBeHidden();
});

test("手機看板只在系統紀錄顯示入口短暫中斷，鈴鐺顯示完整異常說明", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const outage = "HTTPS 入口中斷約 1 分鐘後恢復";
  const explanation =
    "服務異常：隔離執行器。系統連不上服務，服務可能還沒啟動。請確認服務已啟動，再到設定頁按「檢查連線」。";
  await mockDashboard(page, {
    state: {
      tasks: [],
      activity: [
        {
          id: 1,
          task_id: null,
          kind: "tunnel_brief_outage",
          detail: outage,
          created_at: "2026-01-01T08:00:00Z",
        },
      ],
      alerts: [
        {
          id: "demo-service-down",
          task_id: null,
          kind: "service_down",
          disposition: "action",
          title: null,
          text: explanation,
          created_at: "2026-01-01T09:00:00Z",
        },
      ],
    },
  });
  await page.goto("/");
  const history = page.locator("#inbox-activity");
  const toggle = page.getByRole("button", { name: "顯示系統紀錄" });
  await expect(toggle).toBeVisible();
  await expect(history.getByText(outage)).toHaveCount(0);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.press("Enter");
  await expect(history.getByText(outage)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "隱藏系統紀錄" }),
  ).toHaveAttribute("aria-expanded", "true");

  const bell = page.getByRole("button", { name: "通知，1 則未讀" });
  await expect(bell).toBeVisible();
  await bell.press("Enter");
  const menu = page.getByRole("menu");
  const notice = menu.getByText(explanation, { exact: true });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCSS("-webkit-line-clamp", "none");
  await expect(menu.getByText(outage)).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

for (const width of [1280, 375]) {
  test(`通知與收件匣的待處理數一致（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const approval: Alert = {
      id: "demo-approval",
      task_id: task.id,
      kind: "approval",
      disposition: "inbox",
      title: task.title,
      text: "請確認範例任務。",
      created_at: "2026-01-01T08:00:00Z",
    };
    const result: Alert = {
      id: "demo-recovery",
      task_id: null,
      kind: "service_up",
      disposition: "result",
      title: null,
      text: "範例服務曾中斷約 2 分鐘，已恢復。",
      created_at: "2026-01-01T09:00:00Z",
    };
    let completed = false;
    await mockDashboard(page);
    // 看板請求狀態時會帶分頁參數，依路徑比對才能套用這組通知資料。
    await page.route(
      (url) => url.pathname === "/api/state",
      (route) =>
        route.fulfill({
          json: {
            ...defaultState,
            tasks: [completed ? { ...task, status: "rejected" } : task],
            alerts: [
              result,
              completed ? { ...approval, disposition: "resolved" } : approval,
            ],
            alertsSeenAt: completed ? "2026-01-02T00:00:00Z" : null,
          },
        }),
    );
    await page.goto("/");
    const bell = page.getByRole("button", { name: /^通知(?:，|$)/ });
    await expect(bell).toHaveAccessibleName("通知，2 則未讀");
    await expect(
      page.getByRole("button", { name: /^需要你處理 1/ }),
    ).toBeVisible();
    await bell.click();
    const menu = page.getByRole("menu");
    const notices = menu.getByRole("menuitem").filter({ hasText: /範例/ });
    await expect(notices.first()).toContainText("請確認範例任務。");
    await expect(
      notices.first().getByText("等你決定", { exact: true }),
    ).toHaveCount(1);
    await expect(
      notices.first().getByText("需要你處理", { exact: true }),
    ).toHaveCount(0);
    await expect(notices.last()).toContainText(
      "範例服務曾中斷約 2 分鐘，已恢復。",
    );
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(bell).toBeFocused();
    await expect(bell).toHaveAccessibleName("通知，1 則未讀");
    await expect(
      page.getByRole("button", { name: /^需要你處理 1/ }),
    ).toBeVisible();

    completed = true;
    await page.getByRole("button", { name: "重新整理" }).click();
    await expect(
      page.getByRole("heading", { name: "都處理完了" }),
    ).toBeVisible();
    await expect(bell).toHaveAccessibleName("通知");
    await bell.click();
    await expect(
      menu.getByRole("menuitem", { name: /請確認範例任務/ }),
    ).toBeVisible();
  });
}

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

test("登記資料庫連線會切換專案分頁並聚焦第一個欄位", async ({ page }) => {
  const example = {
    ...project,
    name: "示範專案",
    setup_mode: "auto" as const,
    setup_plan: {
      branch: "main",
      sha: "abc123",
      fingerprint: "demo",
      configVersion: 1,
      install: "",
      test: "",
      verification: "tests" as const,
      dataSource: "inferred" as const,
      explanation: "範例測試使用推測的資料庫結構。",
      evidence: [],
    },
  };
  await mockDashboard(page, { state: { projects: [example] } });
  await page.goto("/projects");
  await page.getByRole("button", { name: /示範專案/ }).click();
  const detail = page.getByRole("dialog", { name: "示範專案" });
  await detail.getByRole("tab", { name: /^環境驗證/ }).click();
  await detail.getByRole("button", { name: "登記資料庫連線" }).press("Enter");
  await expect(detail.getByRole("tab", { name: "連線與權限" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByRole("textbox", { name: "用白話描述連線" })).toBeFocused();
  await expect(page).toHaveURL("/projects");
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
  await page
    .getByRole("region", { name: "資料庫連線" })
    .getByRole("button", { name: "交給 AI 整理" })
    .click();
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

test("你可以用白話整理多台 SSH 主機，再逐台核對草稿並儲存", async ({
  page,
}) => {
  await mockDashboard(page);
  const base = "**/api/projects/project-demo/ssh-hosts";
  const description =
    "測試台 lab-a.example.test 帳號 reader 密碼 fictional-ssh-pass，日誌在 C:/logs；測試台 lab-b.example.test 埠 2222 帳號 observer";
  const writes: unknown[] = [];
  const first = {
    name: "lab-a",
    host: "lab-a.example.test",
    port: 22,
    username: "reader",
    note: "日誌在 C:/logs",
    password: "fictional-ssh-pass",
    privateKey: null,
    passphrase: null,
  };
  const second = {
    name: "lab-b",
    host: "lab-b.example.test",
    port: 2222,
    username: "observer",
    note: null,
    password: null,
    privateKey: null,
    passphrase: null,
  };
  await page.route(`${base}/extract`, (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ text: description });
    return route.fulfill({
      json: {
        hosts: [
          { ...first, probe: { reachable: true, detail: "連得到" } },
          { ...second, probe: { reachable: false, detail: "連接埠拒絕連線" } },
        ],
      },
    });
  });
  await page.route(base, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    expect(route.request().method()).toBe("POST");
    writes.push(route.request().postDataJSON());
    return route.fulfill({
      json: [
        {
          id: "fictional-ssh-host",
          name: first.name,
          host: first.host,
          port: first.port,
          username: first.username,
          note: first.note,
          auth: "password",
          hostKey: null,
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      ],
    });
  });

  await page.goto("/projects");
  await page.getByText("測試專案", { exact: true }).first().click();
  await page.getByRole("tab", { name: "連線與權限" }).click();
  const section = page.getByRole("region", { name: "SSH 主機" });
  const input = section.getByLabel("用白話描述主機");
  await input.fill(description);
  await section.getByRole("button", { name: "交給 AI 整理" }).click();
  const drafts = section.getByRole("list", { name: "SSH 主機草稿" });
  const firstDraft = drafts.getByRole("listitem").filter({ hasText: "lab-a" });
  const secondDraft = drafts.getByRole("listitem").filter({ hasText: "lab-b" });
  await expect(firstDraft).toContainText("lab-a.example.test:22");
  await expect(firstDraft).toContainText("你可以從伺服器連到這個連接埠");
  await expect(secondDraft).toContainText("lab-b.example.test:2222");
  await expect(secondDraft).toContainText("連接埠拒絕連線");
  await expect(input).toHaveValue("");
  expect(writes).toHaveLength(0);

  await firstDraft.getByRole("button", { name: "核對草稿" }).click();
  await expect(section.getByLabel("登入密碼")).toHaveValue(first.password);
  await section.getByLabel(/用途說明/).fill("查看測試日誌");
  expect(writes).toHaveLength(0);
  await section.getByRole("button", { name: "確認並儲存" }).click();
  await expect(firstDraft).toHaveCount(0);
  await expect(secondDraft).toBeVisible();
  expect(writes).toEqual([
    {
      name: first.name,
      host: first.host,
      port: first.port,
      username: first.username,
      note: "查看測試日誌",
      password: first.password,
    },
  ]);
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

test("你能在手機首屏看到查詢重點，並從底部修改這一題", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const version = "a".repeat(40);
  const summary = "請確認範例服務的整理流程是否正常。".repeat(5);
  const shortTitle = `追問：${summary.slice(0, 60)}`;
  const completed = {
    ...task,
    title: shortTitle,
    summary,
    acceptance: [`回答追問：${summary}`],
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
        thread: {
          before: [{ ...task, id: "previous-demo", title: "確認範例服務" }],
          after: [],
        },
        groupDeliveries: [
          {
            id: "delivery-demo",
            kind: "group_answered",
            text: "範例結論。",
            delivery: { status: "pending", reason: "quota" },
          },
        ],
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
  await page.goto("/tasks");
  // 任務頁預設只列進行中與待處理；已回覆的查詢在「已結束」。
  await page.getByRole("tab", { name: /^已結束/ }).click();
  await page
    .getByRole("button", { name: new RegExp(`${shortTitle}…`) })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "先看重點" }),
  ).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText("範例結論。", { exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(
    dialog.getByRole("heading", { name: "驗收條件", exact: true }),
  ).toHaveCount(0);
  const amend = dialog.getByRole("button", { name: "修改這一題", exact: true });
  await expect(dialog.getByText("修改這一題", { exact: true })).toHaveCount(1);
  await expect(amend).toBeInViewport({ ratio: 1 });
  await amend.click();
  await expect(dialog.getByLabel("需求說明")).toBeFocused();
  await expect(dialog.getByLabel("驗收條件（每行一項）")).toHaveValue(
    `回答追問：${summary}`,
  );
  await dialog.getByRole("button", { name: "收合修改表單" }).click();
  await expect(dialog.getByLabel("需求說明")).toBeHidden();
  await dialog.getByText("查看完整標題").click();
  await expect(
    dialog.getByText(`追問：${summary}`, { exact: true }),
  ).toBeVisible();
  await dialog.getByText("查詢時的專案、分支與版本").click();
  await expect(dialog.getByText(version, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/範例來源（demo\/source）/)).toBeVisible();
});

for (const status of ["ready", "merged"] as const) {
  test(`你能先看到 PR 連結與摘要（${status === "ready" ? "待合併" : "已合併"}）`, async ({
    page,
  }) => {
    const completed: Task = {
      ...task,
      mode: "change",
      status,
      pr_number: 12,
      pr_url: "https://demo.invalid/pull/12",
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
              version: completed.version,
              pr_summary: "已更新範例頁面。",
            },
          ],
        },
      },
    });
    await page.goto(`/tasks?task=${task.id}`);
    const dialog = page.getByRole("dialog");
    const result = dialog.getByRole("heading", { name: "修改結果" });
    await expect(result).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByText("已更新範例頁面。")).toBeInViewport({
      ratio: 1,
    });
    await expect(dialog.getByRole("link", { name: /PR #12/ })).toHaveAttribute(
      "href",
      completed.pr_url!,
    );
    await expect(
      result.locator("xpath=following::section[@aria-label='處理專案']"),
    ).toHaveCount(1);
    await expect(
      dialog.getByRole("heading", { name: "驗收條件", exact: true }),
    ).toBeVisible();
  });
}

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
    await expect(
      row.getByText("驗證中", { exact: true }).first(),
    ).toBeVisible();
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
          disposition: "action",
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
  await page.goto("/settings?tab=connections");
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
