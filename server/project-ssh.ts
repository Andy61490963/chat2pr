import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Project } from "../shared/types.js";
import {
  maxSshHosts,
  sshHostNamePattern,
  type SshHostView,
  type SshTestResult,
} from "../shared/project-ssh.js";
import { AppError } from "./policy.js";
import { requireAdmin } from "./auth.js";
import { replyError } from "./error-reply.js";
import { Database } from "./db.js";
import { seal, unseal } from "./project-database.js";
import type { RunnerCall } from "./checks.js";
import type { SshLoginInput, SshLoginResult } from "./ssh-login.js";

/**
 * 完全存取的專案可登記 SSH 主機。機密與資料庫連線用同一把金鑰加密保存，只在
 * 測試登入（主機執行器）與完全存取的任務容器（AGENTFLOW_SSH_HOSTS）解開；API 不回傳。
 */
export interface SshHostRow {
  id: string;
  project_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  note: string;
  host_key: string | null;
  secret: Buffer;
  updated_at: Date;
}

const SshBody = z
  .object({
    name: z
      .string()
      .trim()
      .regex(sshHostNamePattern, "名稱只能用英數字與 . _ -，最多 40 字"),
    host: z.string().trim().min(1, "請填主機").max(253),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().trim().min(1, "請填帳號").max(128),
    password: z.string().max(1000).optional(),
    privateKey: z.string().max(20000).optional(),
    passphrase: z.string().max(1000).optional(),
    note: z.string().trim().max(500).default(""),
  })
  .strict();

const view = (row: SshHostRow): SshHostView => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  username: row.username,
  auth: unseal(row.secret).sshPrivateKey ? "key" : "password",
  note: row.note,
  hostKey: row.host_key,
  updatedAt: new Date(row.updated_at).toISOString(),
});

export async function sshHostViews(db: Database, projectId: string) {
  const rows = await db.query<SshHostRow>(
    "SELECT * FROM project_ssh_hosts WHERE project_id=$1 ORDER BY name",
    [projectId],
  );
  return rows.map(view);
}

/** 交給完全存取任務容器的 SSH 主機：一個 JSON 環境變數，worker 的 agentflow-ssh 讀它。 */
export async function sshAccess(db: Database, projectId: string) {
  const rows = await db.query<SshHostRow>(
    "SELECT * FROM project_ssh_hosts WHERE project_id=$1 ORDER BY name",
    [projectId],
  );
  if (!rows.length)
    return {
      env: [] as string[],
      secrets: [] as string[],
      hosts: [] as SshHostView[],
    };
  const secrets: string[] = [];
  const hosts = rows.map((row) => {
    const s = unseal(row.secret);
    for (const v of [s.sshPassword, s.sshPrivateKey, s.sshPassphrase])
      if (v) secrets.push(v);
    return {
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      note: row.note,
      hostKey: row.host_key,
      ...(s.sshPrivateKey
        ? { privateKey: s.sshPrivateKey, passphrase: s.sshPassphrase }
        : { password: s.sshPassword }),
    };
  });
  const json = JSON.stringify(hosts);
  // 單一環境變數上限約 128 KB（Linux MAX_ARG_STRLEN），執行器也只收 120000 字。
  if (json.length > 100000)
    throw new AppError(
      422,
      "登記的 SSH 主機私鑰合計太大，無法交給工作容器；請刪除用不到的主機或改用較短的金鑰",
    );
  return {
    env: [`AGENTFLOW_SSH_HOSTS=${json}`],
    secrets: [...secrets, json],
    hosts: rows.map(view),
  };
}

export const loginInput = (row: SshHostRow): SshLoginInput => {
  const s = unseal(row.secret);
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    ...(s.sshPrivateKey
      ? { privateKey: s.sshPrivateKey, passphrase: s.sshPassphrase }
      : { password: s.sshPassword }),
    hostKey: row.host_key,
  };
};

export function registerProjectSsh(
  app: FastifyInstance,
  db: Database,
  call: RunnerCall,
) {
  const route = { errorHandler: replyError };
  const ids = (req: { params: unknown }) =>
    z
      .object({ id: z.string().uuid(), hostId: z.string().uuid().optional() })
      .parse(req.params);
  const project = async (id: string) => {
    const row = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
      id,
    ]);
    if (!row) throw new AppError(404, "找不到專案");
    return row;
  };
  const host = async (id: string, hostId: string) => {
    const row = await db.one<SshHostRow>(
      "SELECT * FROM project_ssh_hosts WHERE id=$1 AND project_id=$2",
      [hostId, id],
    );
    if (!row) throw new AppError(404, "找不到這台 SSH 主機");
    return row;
  };
  const base = "/api/projects/:id/ssh-hosts";

  app.get(base, route, async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const { id } = ids(req);
    await project(id);
    return sshHostViews(db, id);
  });

  // 新增或更新（帶 hostId）。更新時沒填密碼或私鑰就沿用原本的；主機、連接埠或帳號改了要重新測試。
  const save = async (
    req: FastifyRequest,
    hostId?: string,
  ) => {
    const actor = await requireAdmin(db, req);
    const { id } = ids(req);
    const target = await project(id);
    const body = SshBody.parse(req.body);
    const old = hostId ? await host(id, hostId) : undefined;
    const previous = old ? unseal(old.secret) : undefined;
    const secret = body.privateKey
      ? {
          password: "",
          sshPrivateKey: body.privateKey,
          ...(body.passphrase ? { sshPassphrase: body.passphrase } : {}),
        }
      : body.password
        ? { password: "", sshPassword: body.password }
        : previous;
    if (!secret || (!secret.sshPassword && !secret.sshPrivateKey))
      throw new AppError(422, "請填密碼或私鑰");
    const same =
      old &&
      old.host === body.host &&
      old.port === body.port &&
      old.username === body.username;
    await db.transaction(async (c) => {
      if (!old) {
        const count = await c.query(
          "SELECT 1 FROM project_ssh_hosts WHERE project_id=$1",
          [id],
        );
        if ((count.rowCount ?? 0) >= maxSshHosts)
          throw new AppError(
            422,
            `每個專案最多登記 ${maxSshHosts} 台 SSH 主機`,
          );
      }
      const values = [
        id,
        body.name,
        body.host,
        body.port,
        body.username,
        body.note,
        seal(secret),
        same ? old.host_key : null,
        actor.login,
      ];
      try {
        if (old)
          await c.query(
            "UPDATE project_ssh_hosts SET name=$2,host=$3,port=$4,username=$5,note=$6,secret=$7,host_key=$8,updated_at=now(),updated_by=$9 WHERE project_id=$1 AND id=$10",
            [...values, old.id],
          );
        else
          await c.query(
            "INSERT INTO project_ssh_hosts(project_id,name,host,port,username,note,secret,host_key,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            values,
          );
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new AppError(409, `這個專案已經有名為 ${body.name} 的主機`);
        throw e;
      }
      await db.audit(
        null,
        "project_ssh",
        `已${old ? "更新" : "登記"}專案「${target.name}」的 SSH 主機 ${body.name}（${body.username}@${body.host}:${body.port}）`,
        c,
      );
    });
    return sshHostViews(db, id);
  };

  app.post(base, route, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return save(req);
  });
  app.put(`${base}/:hostId`, route, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return save(req, ids(req).hostId);
  });

  app.delete(`${base}/:hostId`, route, async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const { id, hostId } = ids(req);
    const target = await project(id);
    const row = await host(id, hostId!);
    await db.transaction(async (c) => {
      await c.query("DELETE FROM project_ssh_hosts WHERE id=$1", [row.id]);
      await db.audit(
        null,
        "project_ssh",
        `已刪除專案「${target.name}」的 SSH 主機 ${row.name}`,
        c,
      );
    });
    return sshHostViews(db, id);
  });

  // 從這台伺服器實際登入一次；第一次成功時記下主機金鑰，之後容器登入前核對。
  app.post(`${base}/:hostId/test`, route, async (req, reply) => {
    await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const { id, hostId } = ids(req);
    const row = await host(id, hostId!);
    const result = await call<SshLoginResult>(
      "ssh/test",
      loginInput(row),
      30000,
    );
    if (result.ok && result.hostKey && !row.host_key)
      await db.query(
        "UPDATE project_ssh_hosts SET host_key=$2 WHERE id=$1 AND host_key IS NULL",
        [row.id, result.hostKey],
      );
    const out: SshTestResult = { ok: result.ok, detail: result.detail };
    return out;
  });
}
