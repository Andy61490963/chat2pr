import type { Database, DbClient } from "./db.js";
import type { GitHub } from "./github.js";
import type { Project, RepoMissingState } from "../shared/types.js";

export type RepoGoneReason = "deleted" | "access" | "missing";
export type RepoLocation = { id: number; full_name: string };
const reasons: Record<RepoGoneReason, string> = {
  deleted: "已在 GitHub 上刪除",
  access: "已移除 GitHub App 的存取權",
  missing:
    "在 GitHub 上找不到了（已刪除、搬到沒有安裝 GitHub App 的帳號或組織，或被移出 GitHub App 的存取範圍）",
};
const quoted = (names: string[]) => names.map((n) => `「${n}」`).join("");

async function announce(c: DbClient, kind: string, id: string, text: string) {
  await c.query("INSERT INTO audit(task_id,kind,detail) VALUES(NULL,$1,$2)", [
    kind,
    text,
  ]);
  await c.query(
    "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES(NULL,$1,$2,$3) ON CONFLICT DO NOTHING",
    [kind, `${kind}:${id}:${Date.now()}`, text],
  );
}

// App 看不到儲存庫了：先停用專案、暫時解除群組綁定、把還沒做的任務交回人工，並通知管理者。
// 看不到不一定是刪除（可能是搬家到還沒安裝 App 的地方），所以原本的啟用狀態、群組綁定與任務都記下來，
// 接回時照原樣復原；只有確定刪除時才把待合併的任務結束。要不要刪除專案由管理者決定。
export async function markRepoMissing(
  c: DbClient,
  repo: string,
  reason: RepoGoneReason,
) {
  const project = (
    await c.query(
      "SELECT * FROM projects WHERE lower(repo)=lower($1) AND repo_missing_at IS NULL FOR UPDATE",
      [repo],
    )
  ).rows[0] as Project | undefined;
  if (!project) return null;
  const groups = (
    await c.query(
      "SELECT g.id,g.name FROM group_projects gp JOIN groups g ON g.id=gp.group_id WHERE gp.project_id=$1 ORDER BY g.name",
      [project.id],
    )
  ).rows as { id: string; name: string }[];
  const waiting = (
    await c.query(
      "UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,project_id=NULL,last_error=$2,updated_at=now() WHERE project_id=$1 AND status IN ('awaiting_approval','queued','budget_wait','failed') RETURNING id",
      [
        project.id,
        `專案「${project.name}」的儲存庫找不到了，請重新指定專案、拒絕，或等儲存庫接回`,
      ],
    )
  ).rows as { id: string }[];
  const deleted = reason === "deleted";
  const ready = (
    await c.query(
      deleted
        ? "UPDATE tasks SET status='closed',updated_at=now() WHERE project_id=$1 AND status='ready' RETURNING id"
        : "SELECT id FROM tasks WHERE project_id=$1 AND status='ready'",
      [project.id],
    )
  ).rows as { id: string }[];
  for (const t of ready)
    await c.query("INSERT INTO audit(task_id,kind,detail) VALUES($1,$2,$3)", [
      t.id,
      deleted ? "closed" : "repo_missing",
      deleted
        ? `儲存庫 ${project.repo} 已刪除，PR 一併結束`
        : `儲存庫 ${project.repo} 目前找不到，PR 先保留；接回後會繼續同步合併狀態`,
    ]);
  const state: RepoMissingState = {
    enabled: project.enabled,
    validated_at: project.validated_at,
    config_version: project.config_version,
    groups: groups.map((g) => g.id),
    tasks: waiting.map((t) => t.id),
    closed: deleted ? ready.map((t) => t.id) : [],
  };
  await c.query(
    "UPDATE projects SET repo_missing_at=now(),enabled=false,validated_at=NULL,validation_error=$2,repo_missing_state=$3 WHERE id=$1",
    [project.id, `儲存庫${reasons[reason]}`, JSON.stringify(state)],
  );
  await c.query("DELETE FROM group_projects WHERE project_id=$1", [project.id]);
  const text = [
    `專案「${project.name}」的儲存庫 ${project.repo} ${reasons[reason]}。已先停用這個專案`,
    groups.length
      ? `，並暫時從群組${quoted(groups.map((g) => g.name))}解除綁定`
      : "",
    waiting.length
      ? `；${waiting.length} 個還沒做的任務請重新指定專案，或等儲存庫接回`
      : "",
    ready.length
      ? deleted
        ? `；${ready.length} 個待合併的任務已結束`
        : `；${ready.length} 個待合併的任務先保留`
      : "",
    deleted
      ? "。到「專案」頁可以改選儲存庫，或刪除這個專案。"
      : "。如果是搬家，把 GitHub App 安裝到新的帳號或組織後，系統會自動接回並恢復原本的設定；也可以到「專案」頁改選儲存庫，確定不再使用就刪除專案。",
  ].join("");
  await announce(c, "repo_missing", project.id, text);
  return project;
}

// 把找不到時記下的群組綁定與任務掛回專案；已經不存在的群組、被改派或處理掉的任務不動。
async function restoreMissing(
  c: DbClient,
  projectId: string,
  s: RepoMissingState,
) {
  await c.query(
    "INSERT INTO group_projects(group_id,project_id) SELECT g.id,$1 FROM groups g WHERE g.id=ANY($2::text[]) ON CONFLICT DO NOTHING",
    [projectId, s.groups],
  );
  const groups = (
    await c.query(
      "SELECT g.name FROM group_projects gp JOIN groups g ON g.id=gp.group_id WHERE gp.project_id=$1 AND g.id=ANY($2::text[]) ORDER BY g.name",
      [projectId, s.groups],
    )
  ).rows.map((r: { name: string }) => r.name);
  // 任務當初是核准過的；專案換過狀態，仍由管理者再核准一次才派工。
  const tasks = await c.query(
    "UPDATE tasks t SET project_id=$1,last_error=NULL,version=version+1,updated_at=now() WHERE t.id=ANY($2::uuid[]) AND t.status='awaiting_approval' AND t.project_id IS NULL AND EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=t.group_id AND gp.project_id=$1) RETURNING t.id",
    [projectId, s.tasks],
  );
  const reopened = (
    await c.query(
      "UPDATE tasks SET status='ready',updated_at=now() WHERE id=ANY($2::uuid[]) AND status='closed' AND project_id=$1 RETURNING id",
      [projectId, s.closed ?? []],
    )
  ).rows as { id: string }[];
  for (const t of reopened)
    await c.query(
      "INSERT INTO audit(task_id,kind,detail) VALUES($1,'ready','儲存庫已接回，PR 重新列入待合併；合併狀態會再與 GitHub 同步')",
      [t.id],
    );
  return [
    groups.length ? `，綁回群組${quoted(groups)}` : "",
    tasks.rowCount
      ? `；${tasks.rowCount} 個任務已掛回這個專案，請重新核准`
      : "",
    reopened.length ? `；${reopened.length} 個待合併的任務已恢復` : "",
  ].join("");
}

// 改用新的路徑。sameRepo 代表還是同一個儲存庫（只是改名或轉移），PR 與 Issue 連結跟著換到新位置。
async function relocate(
  c: DbClient,
  p: Project,
  found: RepoLocation,
  sameRepo = true,
) {
  await c.query("UPDATE projects SET repo=$2,repo_id=$3 WHERE id=$1", [
    p.id,
    found.full_name,
    found.id,
  ]);
  if (!sameRepo || p.repo === found.full_name) return;
  const from = `https://github.com/${p.repo}/`,
    to = `https://github.com/${found.full_name}/`;
  for (const [table, column] of [
    ["tasks", "pr_url"],
    ["tasks", "issue_url"],
    ["project_knowledge", "pr_url"],
  ])
    await c.query(
      `UPDATE ${table} SET ${column}=$3::text||substr(${column},length($2::text)+1) WHERE project_id=$1 AND lower(left(${column},length($2::text)))=lower($2::text)`,
      [p.id, from, to],
    );
}

// GitHub 確認儲存庫在 found 這個位置：路徑變了就跟過去；先前標成找不到的，照記下的原狀復原。
export async function repoFound(
  c: DbClient,
  projectId: string,
  found: RepoLocation,
) {
  const p = (
    await c.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [projectId])
  ).rows[0] as Project | undefined;
  if (!p) return;
  const moved = found.full_name.toLowerCase() !== p.repo.toLowerCase();
  if (moved) {
    // 新位置已經有另一個專案在用，沒辦法兩個專案指向同一個儲存庫；交給管理者決定留哪一個。
    const taken = await c.query(
      "SELECT 1 FROM projects WHERE lower(repo)=lower($1) AND id<>$2",
      [found.full_name, p.id],
    );
    if (taken.rowCount) {
      await markRepoMissing(c, p.repo, "missing");
      return;
    }
  }
  if (!p.repo_missing_at) {
    if (p.repo === found.full_name && Number(p.repo_id) === found.id) return;
    await relocate(c, p, found);
    if (moved)
      await announce(
        c,
        "repo_found",
        p.id,
        `專案「${p.name}」的儲存庫已從 ${p.repo} 搬到 ${found.full_name}（改名或轉移），系統已自動改用新位置；專案設定、群組綁定與任務都不受影響。`,
      );
    return;
  }
  await relocate(c, p, found);
  const where = moved
    ? `已從 ${p.repo} 搬到 ${found.full_name}`
    : `${p.repo} 又找得到了`;
  const s = p.repo_missing_state;
  if (!s) {
    // 舊版標記時沒有記下原狀，只能請管理者重新驗證並勾回群組。
    await c.query(
      "UPDATE projects SET repo_missing_at=NULL,validation_error=$2 WHERE id=$1",
      [
        p.id,
        "GitHub 上又找得到這個儲存庫了；請重新驗證環境，再到群組重新勾選這個專案。",
      ],
    );
    await announce(
      c,
      "repo_found",
      p.id,
      `專案「${p.name}」的儲存庫${where}。請到「專案」頁重新驗證環境，再到群組重新勾選這個專案。`,
    );
    return;
  }
  // 找不到的期間改過環境設定，先前的驗證結果就不能沿用。
  const same = s.config_version === p.config_version;
  await c.query(
    "UPDATE projects SET repo_missing_at=NULL,repo_missing_state=NULL,enabled=$2,validated_at=$3,validation_error=$4 WHERE id=$1",
    [
      p.id,
      same && s.enabled,
      same ? s.validated_at : null,
      same
        ? null
        : "儲存庫已接回，但這段期間改過設定；請重新驗證環境後再啟用。",
    ],
  );
  const restored = await restoreMissing(c, p.id, s);
  await announce(
    c,
    "repo_found",
    p.id,
    [
      `專案「${p.name}」的儲存庫${where}，系統已自動接回`,
      same && s.enabled ? "並重新啟用" : "",
      restored,
      same ? "。" : "。這段期間改過設定，請到「專案」頁重新驗證環境後再啟用。",
    ].join(""),
  );
}

// 管理者把找不到儲存庫的專案改指到另一個儲存庫（p 是改指前的專案）。
// 等同更換環境設定：綁定與任務先掛回，環境要重新驗證後才能啟用。
export async function repointRepo(
  c: DbClient,
  p: Project,
  found: RepoLocation,
) {
  // 編號不同就是另一個儲存庫，原本的 PR 不在裡面；沒記到編號（舊資料）時當成同一個搬了家。
  const sameRepo = !p.repo_id || Number(p.repo_id) === found.id;
  await relocate(c, p, found, sameRepo);
  await c.query(
    "UPDATE projects SET repo_missing_at=NULL,repo_missing_state=NULL,validation_error=NULL WHERE id=$1",
    [p.id],
  );
  if (!sameRepo) {
    const closed = (
      await c.query(
        "UPDATE tasks SET status='closed',updated_at=now() WHERE project_id=$1 AND status='ready' RETURNING id",
        [p.id],
      )
    ).rows as { id: string }[];
    for (const t of closed)
      await c.query(
        "INSERT INTO audit(task_id,kind,detail) VALUES($1,'closed',$2)",
        [
          t.id,
          `專案改用另一個儲存庫 ${found.full_name}，原儲存庫 ${p.repo} 的 PR 不再追蹤`,
        ],
      );
  }
  const s = p.repo_missing_state;
  const restored = s
    ? await restoreMissing(c, p.id, {
        ...s,
        closed: sameRepo ? s.closed : [],
      })
    : "";
  await c.query(
    "INSERT INTO audit(task_id,kind,detail) VALUES(NULL,'repo_found',$1)",
    [
      `專案「${p.name}」的儲存庫由 ${p.repo} 改為 ${found.full_name}${restored}；請重新驗證環境後再啟用`,
    ],
  );
}

// 環境驗證通過代表儲存庫讀得到；還掛著「找不到」的話一併解除並復原（p 是驗證通過當下的專案）。
export async function validatedWhileMissing(c: DbClient, p: Project) {
  if (!p.repo_missing_at) return;
  const s = p.repo_missing_state;
  // 編號清掉，下次定期檢查再依目前路徑補上（同名重建的儲存庫編號會不同）。
  await c.query(
    "UPDATE projects SET repo_missing_at=NULL,repo_missing_state=NULL,repo_id=NULL,enabled=enabled OR $2 WHERE id=$1",
    [p.id, !!s && s.enabled && s.config_version === p.config_version],
  );
  if (!s) return;
  const restored = await restoreMissing(c, p.id, s);
  await announce(
    c,
    "repo_found",
    p.id,
    `專案「${p.name}」重新驗證通過，儲存庫 ${p.repo} 已接回${restored}。`,
  );
}

// Webhook 可能沒訂閱或遺失；定期直接問 GitHub 每個專案的儲存庫現在在哪裡。
// 已經找不到的專案要逐一問每個安裝、比較花請求，scope 可以只查還在的（present）或只查找不到的（missing）。
export async function syncProjectRepos(
  db: Database,
  github: Pick<GitHub, "locateRepo">,
  scope: "all" | "present" | "missing" = "all",
) {
  const projects = await db.query<Project>(
    // 從沒驗證過、也沒綁群組的專案（例如剛建立、App 還沒安裝）不需要提醒。
    "SELECT * FROM projects p WHERE (validated_at IS NOT NULL OR repo_missing_at IS NOT NULL OR EXISTS(SELECT 1 FROM group_projects gp WHERE gp.project_id=p.id)) AND ($1='all' OR (repo_missing_at IS NOT NULL)=($1='missing')) ORDER BY created_at",
    [scope],
  );
  for (const p of projects) {
    try {
      const found = await github.locateRepo(
        p.repo,
        p.repo_id ? Number(p.repo_id) : null,
      );
      await db.transaction(async (c) => {
        if (found) await repoFound(c, p.id, found);
        else await markRepoMissing(c, p.repo, "missing");
      });
    } catch {
      // GitHub 暫時查不到（網路、5xx、憑證）不代表儲存庫不在，下次再查。
    }
  }
}
