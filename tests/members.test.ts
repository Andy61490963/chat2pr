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
    if (login === "ghost") throw Object.assign(new Error("找不到"), { statusCode: 404 });
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
  app.inject({ method: "POST", url: "/api/members", headers: owner, payload: { login, role } });

describe("成員名單與權限", () => {
  it("管理者以 GitHub 帳號加入成員，名單含擁有者且擁有者不可變更", async () => {
    expect((await add("alice", "member")).statusCode).toBe(200);
    expect(lookups).toEqual(["alice"]);
    const list = (await app.inject({ url: "/api/members", headers: owner })).json();
    expect(list.map((m: { github_id: string; role: string }) => [m.github_id, m.role])).toEqual([
      ["1000001", "admin"],
      ["1001", "member"],
    ]);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/members/1000001", headers: owner })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "PUT", url: "/api/members/1000001", headers: owner, payload: { role: "member" } })).statusCode,
    ).toBe(409);
  });
  it("一般成員可看任務並操作，不能改設定或管理名單", async () => {
    await add("alice", "member");
    const alice = await loginAs("1001", "alice");
    const me = (await app.inject({ url: "/api/me", headers: alice })).json();
    expect(me).toMatchObject({ login: "alice", role: "member", owner: false });
    expect((await app.inject({ url: "/api/state", headers: alice })).statusCode).toBe(200);
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
    expect((await db.one<{ status: string }>("SELECT status FROM tasks")).status).toBe("rejected");
    expect(
      (await db.one<{ detail: string }>("SELECT detail FROM audit WHERE task_id=$1 ORDER BY id DESC LIMIT 1", [task.id])).detail,
    ).toContain("alice");
    expect((await app.inject({ url: "/api/members", headers: alice })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/pairing", headers: alice })).statusCode,
    ).toBe(403);
  });
  it("不在名單上的人沒有權限；移除成員立即登出，升為管理者可管理名單", async () => {
    const stranger = await loginAs("9999", "stranger");
    expect((await app.inject({ url: "/api/state", headers: stranger })).statusCode).toBe(401);
    await add("bob", "member");
    const bob = await loginAs("1002", "bob");
    expect(
      (await app.inject({ method: "PUT", url: "/api/members/1002", headers: owner, payload: { role: "admin" } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/members", headers: bob })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/members/1002", headers: owner })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/state", headers: bob })).statusCode).toBe(401);
    expect(await db.query("SELECT 1 FROM sessions WHERE user_id='1002'")).toHaveLength(0);
    expect((await add("ghost", "member")).statusCode).toBe(404);
  });
});

describe("通知鈴鐺", () => {
  it("狀態包含最近通知與個人已讀時間，標記已讀只影響自己", async () => {
    await db.query(
      "INSERT INTO notifications(kind,dedupe_key,text) VALUES('failed','n1','工作需要處理')",
    );
    let state = (await app.inject({ url: "/api/state", headers: owner })).json();
    expect(state.alerts.map((a: { text: string }) => a.text)).toEqual(["工作需要處理"]);
    expect(state.alertsSeenAt).toBeNull();
    expect(
      (await app.inject({ method: "POST", url: "/api/alerts/seen", headers: owner })).statusCode,
    ).toBe(200);
    state = (await app.inject({ url: "/api/state", headers: owner })).json();
    expect(state.alertsSeenAt).not.toBeNull();
    await add("alice", "member");
    const alice = await loginAs("1001", "alice");
    expect((await app.inject({ url: "/api/state", headers: alice })).json().alertsSeenAt).toBeNull();
  });
});
