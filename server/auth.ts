import { createHash } from "node:crypto";
import "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Database } from "./db.js";
import { config, secrets, token } from "./config.js";
import { AppError } from "./policy.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type Role = "admin" | "member";
export interface UserSession {
  user_id: string;
  csrf: string;
  login: string;
  role: Role;
}
/** 擁有者固定為管理者；其他人依成員名單決定角色，不在名單上即無權限。 */
export async function roleOf(db: Database, userId: string) {
  if (userId === config().adminId) return "admin" as Role;
  const m = await db.one<{ role: Role }>(
    "SELECT role FROM members WHERE github_id=$1",
    [userId],
  );
  return m?.role;
}
export async function requireAdmin(db: Database, req: FastifyRequest) {
  const session = await requireUser(db, req);
  if (session.role !== "admin")
    throw new AppError(403, "需要管理者權限");
  return session;
}
export async function requireUser(
  db: Database,
  req: FastifyRequest,
): Promise<UserSession> {
  const cookie = req.cookies.af_session;
  if (!cookie) throw new AppError(401, "請先使用 GitHub 登入");
  const row = await db.one<{ user_id: string; csrf: string; login: string | null }>(
    "SELECT user_id,csrf,login FROM sessions WHERE id_hash=$1 AND expires_at>now()",
    [hash(cookie)],
  );
  const role = row ? await roleOf(db, row.user_id) : undefined;
  if (!row || !role) throw new AppError(401, "登入已過期，請重新登入");
  const session = {
    user_id: row.user_id,
    csrf: row.csrf,
    login: row.login ?? row.user_id,
    role,
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["x-csrf-token"] !== session.csrf)
      throw new AppError(403, "操作驗證失敗");
    const origin = req.headers.origin;
    if (!origin || origin !== new URL(config().publicUrl).origin)
      throw new AppError(403, "不接受跨網站操作");
  }
  return session;
}
export async function registerAuth(app: FastifyInstance, db: Database) {
  const opts = () => ({
    path: "/",
    httpOnly: true,
    secure: config().publicUrl.startsWith("https:"),
    sameSite: "lax" as const,
  });
  app.get("/auth/github", async (req, reply) => {
    // 先回到固定回呼所屬的網域，避免從 localhost 建立的 cookie 無法送到公開回呼。
    const publicUrl = new URL(config().publicUrl);
    if (req.headers.host !== publicUrl.host)
      return reply.redirect(new URL("/auth/github", publicUrl).toString());
    const s = secrets();
    if (!s.githubClientId) throw new AppError(503, "請先於本機設定 GitHub App");
    const state = token();
    await db.query(
      "INSERT INTO oauth_states VALUES($1,now()+interval '10 minutes')",
      [hash(state)],
    );
    reply.setCookie("af_oauth", state, { ...opts(), maxAge: 600 });
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", s.githubClientId);
    u.searchParams.set("state", state);
    u.searchParams.set(
      "redirect_uri",
      `${config().publicUrl}/auth/github/callback`,
    );
    return reply.redirect(u.toString());
  });
  app.get("/auth/github/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!q.state || !q.code || req.cookies.af_oauth !== q.state)
      throw new AppError(403, "登入驗證不符");
    const state = await db.query(
      "DELETE FROM oauth_states WHERE id_hash=$1 AND expires_at>now() RETURNING id_hash",
      [hash(q.state)],
    );
    if (!state.length) throw new AppError(403, "登入連結已失效");
    const s = secrets();
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: s.githubClientId,
          client_secret: s.githubClientSecret,
          code: q.code,
          redirect_uri: `${config().publicUrl}/auth/github/callback`,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const auth = (await response.json()) as { access_token?: string };
    if (!auth.access_token) throw new AppError(401, "GitHub 登入失敗");
    const me = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15000),
    });
    const user = (await me.json()) as { id?: number; login?: string };
    if (!user.id || !(await roleOf(db, String(user.id))))
      throw new AppError(403, "此帳號不在成員名單，請聯絡管理者加入");
    // 成員改名時同步名單上的帳號名稱。
    await db.query("UPDATE members SET login=$2 WHERE github_id=$1", [
      String(user.id),
      user.login ?? "",
    ]);
    const session = token(),
      csrf = token();
    await db.query(
      "INSERT INTO sessions(id_hash,user_id,csrf,expires_at,login) VALUES($1,$2,$3,now()+interval '12 hours',$4)",
      [hash(session), String(user.id), csrf, user.login ?? String(user.id)],
    );
    reply
      .clearCookie("af_oauth", { path: "/" })
      .setCookie("af_session", session, { ...opts(), maxAge: 43200 });
    return reply.redirect("/");
  });
  app.get("/api/me", async (req) => {
    const s = await requireUser(db, req);
    return {
      id: s.user_id,
      login: s.login,
      csrf: s.csrf,
      role: s.role,
      owner: s.user_id === config().adminId,
    };
  });
  app.post("/api/logout", async (req, reply) => {
    await requireUser(db, req);
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [
      hash(req.cookies.af_session!),
    ]);
    reply.clearCookie("af_session", { path: "/" });
    return { ok: true };
  });
}
