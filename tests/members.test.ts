import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { hash } from "../server/auth.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let owner: Awaited<ReturnType<typeof session>>;
const lookups: string[] = [];
beforeEach(async () => {
  await reset();
  await fixture();
  owner = await session();
  lookups.length = 0;
  app = await buildApp(db, undefined, undefined, async (login) => {
    lookups.push(login);
    if (login === "ghost")
      throw Object.assign(new Error("找不到"), { statusCode: 404 });
    return { id: login === "alice" ? 1001 : 1002, login, type: "User" };
  });
});
afterEach(() => app.close());
afterAll(() => db.close());

async function loginAs(id: string, login: string) {
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,csrf,expires_at,login) VALUES($1,$2,$3,now()+interval '1 hour',$4)",
    [hash(`s-${id}`), id, `c-${id}`, login],
  );
  return {
    cookie: `af_session=s-${id}`,
    "x-csrf-token": `c-${id}`,
    origin: "http://localhost:4310",
  };
}
const add = (login: string, role: "admin" | "member") =>
  app.inject({
    method: "POST",
    url: "/api/members",
    headers: owner,
    payload: { login, role },
  });

describe("成員名單與權限", () => {
  it("管理者以 GitHub 帳號加入成員，名單含擁有者且擁有者不可變更", async () => {
    expect((await add("alice", "member")).statusCode).toBe(200);
    expect(lookups).toEqual(["alice"]);
    const list = (
      await app.inject({ url: "/api/members", headers: owner })
    ).json();
    expect(
      list.map((m: { github_id: string; role: string }) => [
        m.github_id,
        m.role,
      ]),
    ).toEqual([
      ["1000001", "admin"],
      ["1001", "member"],
    ]);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/members/1000001",
          headers: owner,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/members/1000001",
          headers: owner,
          payload: { role: "member" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("一般成員可看任務並操作，不能改設定或管理名單", async () => {
    await add("alice", "member");
    const alice = await loginAs("1001", "alice");
    const me = (await app.inject({ url: "/api/me", headers: alice })).json();
    expect(me).toMatchObject({ login: "alice", role: "member", owner: false });
    expect(
      (await app.inject({ url: "/api/state", headers: alice })).statusCode,
    ).toBe(200);
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,dedupe_key) SELECT id,'group-a','查詢','查詢內容','k1' FROM projects LIMIT 1 RETURNING id",
    );
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/actions`,
      headers: alice,
      payload: { action: "reject", version: 1 },
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await db.one<{ status: string }>("SELECT status FROM tasks")).status,
    ).toBe("rejected");
    expect(
      (
        await db.one<{ detail: string }>(
          "SELECT detail FROM audit WHERE task_id=$1 ORDER BY id DESC LIMIT 1",
          [task.id],
        )
      ).detail,
    ).toContain("alice");
    expect(
      (await app.inject({ url: "/api/members", headers: alice })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/pairing",
          headers: alice,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("升為管理者或降為成員時，回傳目標帳號的已儲存角色", async () => {
    const login = "demo-xiaolin";
    const added = await add(login, "member");
    expect(added.statusCode).toBe(200);
    const member = added.json();
    const headers = await loginAs(member.github_id, login);
    for (const [role, access] of [
      ["admin", 200],
      ["member", 403],
    ] as const) {
      const updated = await app.inject({
        method: "PUT",
        url: `/api/members/${member.github_id}`,
        headers: owner,
        payload: { role },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ ...member, role });
      const list = await app.inject({ url: "/api/members", headers: owner });
      expect(list.json()).toContainEqual(updated.json());
      expect(
        (await app.inject({ url: "/api/members", headers })).statusCode,
      ).toBe(access);
    }
  });
  it("不在名單上的人沒有權限；移除成員立即登出，升為管理者可管理名單", async () => {
    const stranger = await loginAs("9999", "stranger");
    expect(
      (await app.inject({ url: "/api/state", headers: stranger })).statusCode,
    ).toBe(401);
    await add("bob", "member");
    const bob = await loginAs("1002", "bob");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/members/1002",
          headers: owner,
          payload: { role: "admin" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/members", headers: bob })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/members/1002",
          headers: owner,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/state", headers: bob })).statusCode,
    ).toBe(401);
    expect(
      await db.query("SELECT 1 FROM sessions WHERE user_id='1002'"),
    ).toHaveLength(0);
    expect((await add("ghost", "member")).statusCode).toBe(404);
  });
});

describe("通知鈴鐺", () => {
  it("成員看得到任務與群組通知，管理者私訊原文與管理稽核只給管理者", async () => {
    await add("alice", "member");
    const member = await loginAs("1001", "alice");
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(group_id,title,summary,dedupe_key) VALUES('group-a','範例任務','範例摘要','bell-task') RETURNING id",
    );
    await db.query(
      `INSERT INTO notifications(kind,task_id,group_id,dedupe_key,text) VALUES
       ('check',NULL,NULL,'check-private','管理端的檢查結果'),
       ('approval',$1,NULL,'task-direct','私訊給管理者的任務說明'),
       ('group_question',$1,'group-a','question-group','群組待回答的問題')`,
      [task.id],
    );
    await db.audit(null, "check_system_issue", "管理端的檢查結果");
    await db.audit(task.id, "approval", "工作區的審核紀錄");
    const read = async (headers: typeof owner) =>
      (await app.inject({ url: "/api/state?activity=2000", headers })).json();
    const adminState = await read(owner);
    const memberState = await read(member);
    expect(adminState.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "管理端的檢查結果" }),
        expect.objectContaining({ text: "私訊給管理者的任務說明" }),
      ]),
    );
    expect(memberState.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: task.id,
          title: "範例任務",
          kind: "approval",
        }),
        expect.objectContaining({ text: "群組待回答的問題" }),
      ]),
    );
    expect(JSON.stringify(memberState)).not.toContain("管理端的檢查結果");
    expect(JSON.stringify(memberState)).not.toContain("私訊給管理者的任務說明");
    expect(
      memberState.activity.map((x: { detail: string }) => x.detail),
    ).toEqual(["工作區的審核紀錄"]);
    expect(memberState.totals.activity).toBe(1);
    expect(adminState.totals.activity).toBeGreaterThan(
      memberState.totals.activity,
    );
  });
  it("鈴鐺不顯示過期群組通知的文字，兩種角色仍可看近期原文", async () => {
    await add("alice", "member");
    const member = await loginAs("1001", "alice");
    await db.query(
      `INSERT INTO notifications(kind,group_id,dedupe_key,text,created_at) VALUES
       ('group_triage','group-a','notice-old','保留期外的群組通知',message_retention_cutoff()),
       ('group_triage','group-a','notice-fresh','保留期內的群組通知',now())`,
    );
    for (const headers of [member, owner]) {
      const { alerts } = (
        await app.inject({ url: "/api/state", headers })
      ).json();
      const texts = alerts.map((x: { text: string }) => x.text);
      expect(texts).toContain("保留期內的群組通知");
      expect(texts).toContain("原文已到期");
      expect(texts).not.toContain("保留期外的群組通知");
    }
  });
  it("狀態包含最近通知與個人已讀時間，標記已讀只影響自己", async () => {
    await db.query(
      "INSERT INTO notifications(kind,dedupe_key,text) VALUES('failed','n1','工作需要處理')",
    );
    let state = (
      await app.inject({ url: "/api/state", headers: owner })
    ).json();
    expect(state.alerts.map((a: { text: string }) => a.text)).toEqual([
      "工作需要處理",
    ]);
    expect(state.alertsSeenAt).toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/alerts/seen",
          headers: owner,
        })
      ).statusCode,
    ).toBe(200);
    state = (await app.inject({ url: "/api/state", headers: owner })).json();
    expect(state.alertsSeenAt).not.toBeNull();
    await add("alice", "member");
    const alice = await loginAs("1001", "alice");
    expect(
      (await app.inject({ url: "/api/state", headers: alice })).json()
        .alertsSeenAt,
    ).toBeNull();
  });
});

it("模型欄位拒絕憑證格式，讀取舊值及更新後的稽核均不含原文", async () => {
  const saved = await db.settings();
  const value = "sk-" + "fictionalOnly5678";
  const update = (model: string) =>
    app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: owner,
      payload: {
        ...saved,
        paused: true,
        triage_effort: "high",
        coding_effort: "medium",
        codex_model: model,
      },
    });
  const rejected = await update(value);
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().details).toContain(
    "codex_model: Codex 模型名稱不可包含憑證",
  );
  expect(rejected.body).not.toContain(value);
  expect((await db.settings()).codex_model).toBe(saved.codex_model);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{codex_model}',to_jsonb($1::text))",
    [value],
  );
  expect((await db.settings()).codex_model).toBeNull();
  const state = (
    await app.inject({ url: "/api/state", headers: owner })
  ).json();
  expect(state.settings.codex_model).toBeNull();
  expect((await update("fictional-model")).statusCode).toBe(200);
  const audit = await db.query<{ detail: string }>(
    "SELECT detail FROM audit WHERE kind='settings'",
  );
  expect(audit.some((row) => row.detail.includes("fictional-model"))).toBe(
    true,
  );
  expect(audit.every((row) => !row.detail.includes(value))).toBe(true);
});
