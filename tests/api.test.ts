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
beforeEach(reset);
afterAll(() => db.close());
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
