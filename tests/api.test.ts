import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-secret",
    githubWebhookSecret: "fictional-github",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { GitHub } from "../server/github.js";
beforeEach(reset);
afterAll(() => db.close());

describe("新增專案不能重複使用同一個儲存庫", () => {
  const body = (name: string, repo: string) => ({
    name,
    repo,
    base_branch: "main",
    image: "fixture-image",
    install_command: "",
    test_command: "",
    sensitive_paths: [],
    enabled: false,
  });
  const create = (
    app: Awaited<ReturnType<typeof buildApp>>,
    headers: Record<string, string>,
    name: string,
    repo: string,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: body(name, repo),
    });

  it("同一儲存庫（含大小寫不同）第二次新增回 409 與中文訊息，不再落到 500", async () => {
    const app = await buildApp(db),
      headers = await session();
    const installation = vi
      .spyOn(GitHub.prototype, "installation")
      .mockResolvedValue(1);
    try {
      expect(
        (await create(app, headers, "虛構訂單", "fictional-org/orders"))
          .statusCode,
      ).toBe(200);
      for (const repo of ["fictional-org/orders", "Fictional-Org/Orders"]) {
        const again = await create(app, headers, "另一個訂單", repo);
        expect(again.statusCode).toBe(409);
        expect(again.json().error).toBe("已經有專案「虛構訂單」使用這個儲存庫");
      }
      // 已被佔用時不必再問 GitHub。
      expect(installation).toHaveBeenCalledTimes(1);
      expect(
        await db.query("SELECT id FROM projects WHERE lower(repo)=$1", [
          "fictional-org/orders",
        ]),
      ).toHaveLength(1);
    } finally {
      installation.mockRestore();
      await app.close();
    }
  });

  it("佔用的專案找不到儲存庫時，訊息引導去那個專案改選位置", async () => {
    const app = await buildApp(db),
      headers = await session();
    await db.query(
      "INSERT INTO projects(name,repo,repo_missing_at) VALUES('虛構舊倉','fictional-org/legacy',now())",
    );
    const installation = vi
      .spyOn(GitHub.prototype, "installation")
      .mockResolvedValue(1);
    try {
      const res = await create(app, headers, "新倉", "FICTIONAL-ORG/legacy");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(
        "專案「虛構舊倉」原本使用這個儲存庫，但目前找不到；請到該專案改選位置，不要另建新專案",
      );
      expect(installation).not.toHaveBeenCalled();
    } finally {
      installation.mockRestore();
      await app.close();
    }
  });

  it("查重之後才被另一個請求搶先建立時，唯一限制的錯誤也轉成 409", async () => {
    const app = await buildApp(db),
      headers = await session();
    // 模擬兩個請求同時送出：查重通過後、INSERT 之前，另一筆先寫進去。
    const installation = vi
      .spyOn(GitHub.prototype, "installation")
      .mockImplementation(async () => {
        await db.query(
          "INSERT INTO projects(name,repo) VALUES('搶先專案','fictional-org/race')",
        );
        return 1;
      });
    try {
      const res = await create(app, headers, "慢一步", "fictional-org/race");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("已經有專案「搶先專案」使用這個儲存庫");
    } finally {
      installation.mockRestore();
      await app.close();
    }
  });
});

describe("所有管理 API 的輸入格式錯誤都回看板讀得懂的格式", () => {
  it("成員與聊天室的路由也回「輸入格式錯誤」與中文提示，不是 Bad Request", async () => {
    await fixture();
    const app = await buildApp(db),
      headers = await session();
    try {
      const member = await app.inject({
        method: "POST",
        url: "/api/members",
        headers,
        payload: { login: "不是 帳號", role: "admin" },
      });
      expect(member.statusCode).toBe(400);
      expect(member.json().error).toBe("輸入格式錯誤");
      expect(member.json().details.join("\n")).toContain(
        "GitHub 帳號格式不正確",
      );
      const chat = await app.inject({
        url: "/api/groups/group-a/messages?before=",
        headers,
      });
      expect(chat.statusCode).toBe(400);
      expect(chat.json().error).toBe("輸入格式錯誤");
      expect(chat.json()).toHaveProperty("details");
    } finally {
      await app.close();
    }
  });
});
describe("工作流程設定的活動紀錄", () => {
  const base = {
    paused: true,
    ai_mode: "api",
    daily_runs: 20,
    codex_model: null,
    triage_effort: "high",
    coding_effort: "medium",
    daily_budget: 15,
    task_budget: 3,
    task_minutes: 30,
    triage_model: "gpt-5.4-mini",
    coding_model: "gpt-6.1-sol",
  };
  const settingsAudits = async () =>
    (
      await db.query<{ detail: string }>(
        "SELECT detail FROM audit WHERE kind='settings' ORDER BY id",
      )
    ).map((r) => r.detail);
  it("寫出操作者與改了什麼；開放容器網路寫成「隔離 → 完全開放」", async () => {
    const headers = await session(),
      app = await buildApp(db);
    await db.query("UPDATE sessions SET login='fictional-admin'");
    const put = (payload: object) =>
      app.inject({ method: "PUT", url: "/api/settings", headers, payload });
    expect((await put({ ...base, container_network: "open" })).statusCode).toBe(
      200,
    );
    const first = await settingsAudits();
    expect(first[0]).toContain("管理者 fictional-admin 更新工作流程設定：");
    expect(first[0]).toContain("容器網路：隔離 → 完全開放");
    expect(first[0]).toContain("派工：自動派工 → 已暫停");
    // 派工由進行中改成暫停時另寫一筆，方便從活動紀錄找出何時停的。
    expect(first.slice(1)).toEqual(["暫停新派工"]);

    await db.query("DELETE FROM audit WHERE kind='settings'");
    expect(
      (await put({ ...base, container_network: "open", daily_runs: 30 }))
        .statusCode,
    ).toBe(200);
    expect(await settingsAudits()).toEqual([
      "管理者 fictional-admin 更新工作流程設定：每日最多執行次數：20 → 30",
    ]);

    await db.query("DELETE FROM audit WHERE kind='settings'");
    expect(
      (await put({ ...base, container_network: "open", daily_runs: 30 }))
        .statusCode,
    ).toBe(200);
    expect(await settingsAudits()).toEqual([
      "管理者 fictional-admin 更新工作流程設定：沒有變更",
    ]);
    await app.close();
  });
});
describe("公開 Webhook 與管理 API 邊界", () => {
  it("非管理者即使持有有效工作階段與 CSRF 仍不能讀取或修改設定", async () => {
    const headers = await session(),
      app = await buildApp(db);
    await db.query("UPDATE sessions SET user_id='999999'");
    expect((await app.inject({ url: "/api/state", headers })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: { paused: false },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
  it("圖片撤回後管理 API 與需求來源均無法再讀取內容", async () => {
    const project = await fixture(),
      headers = await session(),
      app = await buildApp(db);
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,image,image_mime) VALUES('picture','group-a','image','圖片說明',$1,'image/png')",
      [Buffer.from("image")],
    );
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,source_ids,dedupe_key) VALUES($1,'group-a','圖片需求','摘要',ARRAY['picture'],'image-read') RETURNING id",
      [project],
    );
    expect(
      (await app.inject({ url: "/api/messages/picture/image", headers }))
        .statusCode,
    ).toBe(200);
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: "withdraw-picture",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "picture" },
        },
      ],
    });
    expect(
      (await app.inject({ url: "/api/messages/picture/image", headers }))
        .statusCode,
    ).toBe(404);
    const detail = (
      await app.inject({ url: `/api/tasks/${task.id}`, headers })
    ).json();
    expect(detail.sources[0].text).toBe(null);
    expect(detail.sources[0].has_image).toBe(false);
    expect(detail.task.approved_version).toBe(null);
    await app.close();
  });
  it("GitHub 簽章、儲存庫關聯及重送識別碼共同保護 PR 狀態", async () => {
    const project = await fixture(),
      app = await buildApp(db);
    await db.query(
      "INSERT INTO tasks(project_id,group_id,title,summary,status,pr_number,dedupe_key) VALUES($1,'group-a','測試','摘要','ready',7,'github-event')",
      [project],
    );
    const send = (id: string, repo: string, merged: boolean, valid = true) => {
      const body = JSON.stringify({
        repository: { full_name: repo },
        pull_request: { number: 7, state: "closed", merged },
      });
      return app.inject({
        method: "POST",
        url: "/webhooks/github",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-github-delivery": id,
          "x-hub-signature-256": valid
            ? "sha256=" +
              createHmac("sha256", "fictional-github")
                .update(body)
                .digest("hex")
            : "bad",
        },
      });
    };
    expect((await send("invalid", "test/repo", true, false)).statusCode).toBe(
      401,
    );
    await send("other-repo", "test/other", true);
    expect((await db.one("SELECT status FROM tasks")).status).toBe("ready");
    await send("merge-1", "test/repo", true);
    await send("merge-1", "test/repo", false);
    expect((await db.one("SELECT status FROM tasks")).status).toBe("merged");
    expect(
      await db.query("SELECT id FROM events WHERE id='github:merge-1'"),
    ).toHaveLength(1);
    // 時間軸記一筆合併；重送或狀態沒變不重複記錄。
    await send("merge-2", "test/repo", true);
    expect(
      (await db.query("SELECT detail FROM audit WHERE kind='merged'")).map(
        (r) => (r as { detail: string }).detail,
      ),
    ).toEqual(["PR #7 已在 GitHub 合併"]);
    await app.close();
  });
  it("清理尚未執行時也無法讀取過期來源與圖片", async () => {
    const project = await fixture();
    const headers = await session();
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,image,image_mime,received_at) VALUES('expired','group-a','image','過期原文',$1,'image/png',now()-interval '31 days')",
      [Buffer.from("image")],
    );
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,source_ids,dedupe_key) VALUES($1,'group-a','摘要','摘要',ARRAY['expired'],'expiry') RETURNING id",
      [project],
    );
    const app = await buildApp(db);
    const detail = await app.inject({ url: `/api/tasks/${task.id}`, headers });
    expect(detail.json().sources[0].text).toBe(null);
    expect(detail.json().sources[0].has_image).toBe(false);
    expect(
      (await app.inject({ url: "/api/messages/expired/image", headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await db.one<{ text: string }>("SELECT text FROM messages")).text,
    ).toBe("過期原文");
    await app.close();
  });
  it("未登入與缺少 CSRF 的操作都會被拒絕", async () => {
    const app = await buildApp(db);
    expect((await app.inject("/api/state")).statusCode).toBe(401);
    const headers = await session();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
  it("正確簽章可收訊，偽造簽章不可新增資料", async () => {
    const app = await buildApp(db);
    const body = JSON.stringify({
      events: [
        {
          webhookEventId: "a",
          type: "message",
          source: { type: "group", groupId: "group-z" },
          message: { id: "m", type: "text", text: "修復顯示錯誤" },
        },
      ],
    });
    const headers = {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-secret")
        .update(body)
        .digest("base64"),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/line",
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/line",
          headers: { ...headers, "x-line-signature": "bad" },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    expect((await db.query("SELECT id FROM messages")).length).toBe(1);
    await app.close();
  });
  it("同源登入者可讀看板，但不能跳過專案驗證", async () => {
    await fixture();
    const headers = await session(),
      app = await buildApp(db);
    const state = await app.inject({ url: "/api/state", headers });
    expect(state.statusCode).toBe(200);
    expect(state.json().groups[0].id).toBe("group-a");
    expect(JSON.stringify(state.json())).not.toContain("fictional-secret");
    await db.query("UPDATE projects SET validated_at=NULL");
    const changed = await app.inject({
      method: "PUT",
      url: "/api/groups/group-a",
      headers,
      payload: {
        name: "新群組",
        project_ids: [state.json().projects[0].id],
        enabled: true,
      },
    });
    expect(changed.statusCode).toBe(409);
    await app.close();
  });
  it("偽造 Origin 即使有 CSRF token 也不能操作", async () => {
    const headers = await session(),
      app = await buildApp(db);
    const r = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...headers, origin: "https://attacker.example" },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    await app.close();
  });
  it("一次性 LINE 配對碼不能被另一人重複使用", async () => {
    const headers = await session(),
      app = await buildApp(db);
    const { code } = (
      await app.inject({
        method: "POST",
        url: "/api/pairing",
        headers,
        payload: {},
      })
    ).json();
    for (const [event, user] of [
      ["p1", "admin-line"],
      ["p2", "other-line"],
    ]) {
      const body = JSON.stringify({
        events: [
          {
            webhookEventId: event,
            type: "message",
            source: { type: "user", userId: user },
            message: { id: event, type: "text", text: `配對 ${code}` },
          },
        ],
      });
      await app.inject({
        method: "POST",
        url: "/webhooks/line",
        headers: {
          "content-type": "application/json",
          "x-line-signature": createHmac("sha256", "fictional-secret")
            .update(body)
            .digest("base64"),
        },
        payload: body,
      });
    }
    expect((await db.settings()).admin_line_id).toBe("admin-line");
    await app.close();
  });
});
