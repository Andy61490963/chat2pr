import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { hash } from "../server/auth.js";
import { GitHub } from "../server/github.js";
import { db, reset, session } from "./helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>,
  admin: Awaited<ReturnType<typeof session>>;
const catalog = {
  names: ["main", "develop", "release/2026", "修正/機台欄位"],
  defaultBranch: "develop",
  truncated: false,
};
let asked: string[];
beforeEach(async () => {
  await reset();
  admin = await session();
  app = await buildApp(db);
  asked = [];
  vi.spyOn(GitHub.prototype, "branches").mockImplementation(async (p) => {
    asked.push(p.repo);
    return catalog;
  });
  vi.spyOn(GitHub.prototype, "installation").mockResolvedValue(1);
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

const url = "/api/repositories/branches?repo=fictional-org%2Fmes.web";
const project = (base_branch: string) => ({
  name: "分支選單測試",
  repo: "fictional-org/mes.web",
  description: "",
  base_branch,
  image: "測試映像",
  install_command: "",
  test_command: "true",
  sensitive_paths: [],
  enabled: false,
});

it("管理者可即時取得儲存庫的分支清單與 GitHub 預設分支", async () => {
  const response = await app.inject({ url, headers: admin });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual(catalog);
  expect(asked).toEqual(["fictional-org/mes.web"]);
});

it("未登入與一般成員不能列出儲存庫分支", async () => {
  expect((await app.inject({ url })).statusCode).toBe(401);
  await db.query(
    "INSERT INTO members(github_id,login,role,added_by) VALUES('900002','fictional-member','member','owner')",
  );
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,csrf,expires_at,login) VALUES($1,'900002','c-member',now()+interval '1 hour','fictional-member')",
    [hash("s-member")],
  );
  const member = await app.inject({
    url,
    headers: { cookie: "af_session=s-member" },
  });
  expect(member.statusCode).toBe(403);
  expect(asked).toEqual([]);
});

it.each(["", "只有名稱", "a/b/c", "../x", "org/repo?x=1"])(
  "儲存庫名稱「%s」格式不對時不查詢 GitHub",
  async (repo) => {
    const response = await app.inject({
      url: `/api/repositories/branches?repo=${encodeURIComponent(repo)}`,
      headers: admin,
    });
    expect(response.statusCode).toBe(400);
    expect(asked).toEqual([]);
  },
);

it("清單列得出來的分支名稱都能存成專案的基底分支", async () => {
  for (const name of catalog.names) {
    await db.query("DELETE FROM projects");
    const saved = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: admin,
      payload: project(name),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().base_branch).toBe(name);
  }
});

it.each(["", "a..b", "-x", "refs/heads/main", "有 空白", "a".repeat(201)])(
  "不是分支名稱的「%s」不能存成基底分支",
  async (name) => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: admin,
      payload: project(name),
    });
    expect(saved.statusCode).toBe(400);
  },
);
