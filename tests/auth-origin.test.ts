import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ githubClientId: "驗收專用應用程式" }),
}));
import { db, reset } from "./helpers.js";
import { buildApp } from "../server/app.js";
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  app = await buildApp(db);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});
afterAll(() => db.close());

it("從不同網域開啟登入時，先轉到固定回呼來源，尚不建立跨網域 cookie", async () => {
  const response = await app.inject({
    url: "/auth/github",
    headers: { host: "127.0.0.1:4310", "x-forwarded-host": "evil.example" },
  });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe("http://localhost:4310/auth/github");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(
    (await db.one<{ n: number }>("SELECT count(*)::int n FROM oauth_states")).n,
  ).toBe(0);
});

it("固定來源會建立短效 state cookie，並送往相同來源的 OAuth 回呼", async () => {
  const response = await app.inject({
    url: "/auth/github",
    headers: { host: "localhost:4310" },
  });
  expect(response.statusCode).toBe(302);
  expect(response.headers["set-cookie"]).toContain("af_oauth=");
  const redirect = new URL(String(response.headers.location));
  expect(redirect.origin).toBe("https://github.com");
  expect(redirect.searchParams.get("redirect_uri")).toBe(
    "http://localhost:4310/auth/github/callback",
  );
  expect(
    (await db.one<{ n: number }>("SELECT count(*)::int n FROM oauth_states")).n,
  ).toBe(1);
});

it.each([
  ["settings-secrets", "/settings#settings-secrets"],
  ["https://fictional.invalid/escaped", "/"],
])("重新登入只允許回到預定的看板位置（%s）", async (target, expected) => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: "fictional-github-login-token" }))
    .mockResolvedValueOnce(Response.json({ id: 1000001, login: "fictional-owner" })));
  const start = await app.inject({
    url: `/auth/github?returnTo=${encodeURIComponent(target)}`,
    headers: { host: "localhost:4310" },
  });
  expect(start.statusCode).toBe(302);
  const state = new URL(String(start.headers.location)).searchParams.get("state");
  const callback = await app.inject({
    url: `/auth/github/callback?state=${state}&code=fictional-code&returnTo=https://fictional.invalid`,
    headers: { host: "localhost:4310", cookie: `af_oauth=${state}` },
  });
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toBe(expected);
  expect(await db.one("SELECT created_at IS NOT NULL AS dated FROM sessions")).toEqual({ dated: true });
});
