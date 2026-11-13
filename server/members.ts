import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { AppError } from "./policy.js";

export interface Member {
  github_id: string;
  login: string;
  role: "admin" | "member";
  added_by: string | null;
  created_at: string;
  owner?: boolean;
}

// 以 GitHub 公開 API 把帳號名稱換成固定的數字 ID；改名後仍是同一個人。
async function lookupGithubUser(login: string) {
  const r = await fetch(
    `https://api.github.com/users/${encodeURIComponent(login)}`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (r.status === 404) throw new AppError(404, `找不到 GitHub 帳號 ${login}`);
  if (!r.ok) throw new AppError(502, "暫時無法查詢 GitHub 帳號，請稍後再試");
  const u = z
    .object({ id: z.number(), login: z.string(), type: z.string() })
    .parse(await r.json());
  if (u.type !== "User") throw new AppError(400, "只能加入個人帳號");
  return u;
}

export function registerMembers(
  app: FastifyInstance,
  db: Database,
  lookup = lookupGithubUser,
) {
  app.get("/api/members", async (req): Promise<Member[]> => {
    await requireAdmin(db, req);
    const owner = config().adminId;
    const rows = await db.query<Member>(
      "SELECT github_id,login,role,added_by,created_at FROM members ORDER BY created_at",
    );
    const ownerLogin = (
      await db.one<{ login: string | null }>(
        "SELECT login FROM sessions WHERE user_id=$1 AND login IS NOT NULL ORDER BY expires_at DESC LIMIT 1",
        [owner],
      )
    )?.login;
    return [
      {
        github_id: owner,
        login: ownerLogin ?? owner,
        role: "admin",
        added_by: null,
        created_at: "",
        owner: true,
      },
      ...rows.filter((m) => m.github_id !== owner),
    ];
  });
  app.post("/api/members", async (req) => {
    const actor = await requireAdmin(db, req);
    const b = z
      .object({
        login: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "GitHub 帳號格式不正確"),
        role: z.enum(["admin", "member"]),
      })
      .parse(req.body);
    const u = await lookup(b.login);
    if (String(u.id) === config().adminId)
      throw new AppError(409, "擁有者已是管理者");
    const m = await db.one<Member>(
      "INSERT INTO members(github_id,login,role,added_by) VALUES($1,$2,$3,$4) ON CONFLICT(github_id) DO UPDATE SET login=EXCLUDED.login,role=EXCLUDED.role RETURNING github_id,login,role,added_by,created_at",
      [String(u.id), u.login, b.role, actor.login],
    );
    await db.audit(
      null,
      "member",
      `${actor.login} 加入成員 ${u.login}（${b.role === "admin" ? "管理者" : "成員"}）`,
    );
    return m;
  });
  app.put("/api/members/:id", async (req) => {
    const actor = await requireAdmin(db, req);
    const id = z.string().regex(/^\d+$/).parse((req.params as { id: string }).id);
    if (id === config().adminId) throw new AppError(409, "不能變更擁有者");
    const { role } = z
      .object({ role: z.enum(["admin", "member"]) })
      .parse(req.body);
    const m = await db.one<Member>(
      "UPDATE members SET role=$2 WHERE github_id=$1 RETURNING github_id,login,role,added_by,created_at",
      [id, role],
    );
    if (!m) throw new AppError(404, "找不到成員");
    await db.audit(
      null,
      "member",
      `${actor.login} 將 ${m.login} 改為${role === "admin" ? "管理者" : "成員"}`,
    );
    return m;
  });
  app.delete("/api/members/:id", async (req) => {
    const actor = await requireAdmin(db, req);
    const id = z.string().regex(/^\d+$/).parse((req.params as { id: string }).id);
    if (id === config().adminId) throw new AppError(409, "不能移除擁有者");
    const m = await db.one<{ login: string }>(
      "DELETE FROM members WHERE github_id=$1 RETURNING login",
      [id],
    );
    if (!m) throw new AppError(404, "找不到成員");
    // 移除後立即登出該成員的所有裝置。
    await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await db.audit(null, "member", `${actor.login} 移除成員 ${m.login}`);
    return { ok: true };
  });
}
