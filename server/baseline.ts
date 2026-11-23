import type { Database } from "./db.js";
import type { GitHub } from "./github.js";
import { randomUUID } from "node:crypto";
import type { Project, Task } from "../shared/types.js";
import { baselineFailurePlain, parseFailure } from "../shared/failure-text.js";
import { AppError } from "./policy.js";
import { approvalNotice } from "./project-routing.js";
import { describeTestFailures, parseTestFailures } from "./test-failures.js";

/** 同一專案、同一分支上一次基底測試全部通過的 commit，以及之後目標分支多了幾個 commit。 */
export interface BaselineSince {
  sha: string;
  /** 之後的新 commit 數；GitHub 比較失敗時不知道。 */
  ahead: number | null;
  compareUrl: string;
}

/** 基底測試全部通過時記下這個 commit（專案驗證與派工前的基底驗證都算）。 */
export async function recordBaselinePass(
  db: Database,
  projectId: string,
  branch: string,
  sha: string,
) {
  await db.query(
    "INSERT INTO baseline_passes(project_id,branch,sha) VALUES($1,$2,$3) ON CONFLICT(project_id,branch) DO UPDATE SET sha=EXCLUDED.sha,passed_at=now()",
    [projectId, branch, sha],
  );
}

/**
 * 找上一次通過的 commit：先看記錄，沒有記錄時用專案驗證保存的設定（同一分支才算）。
 * 都沒有就回傳 null，失敗說明不顯示這一段。
 */
export async function baselineSince(
  db: Database,
  github: Pick<GitHub, "compareCommits">,
  project: Project,
  sha: string,
): Promise<BaselineSince | null> {
  const recorded = await db.one<{ sha: string }>(
    "SELECT sha FROM baseline_passes WHERE project_id=$1 AND branch=$2",
    [project.id, project.base_branch],
  );
  const plan = project.setup_plan;
  const passed =
    recorded?.sha ??
    (project.validated_at && plan?.branch === project.base_branch
      ? plan.sha
      : null);
  if (!passed) return null;
  const fallbackUrl = `https://github.com/${project.repo}/compare/${passed}...${sha}`;
  if (passed === sha) return { sha: passed, ahead: 0, compareUrl: fallbackUrl };
  const compared = await github
    .compareCommits(project, passed, sha)
    .catch(() => null);
  return {
    sha: passed,
    ahead: compared?.aheadBy ?? null,
    compareUrl: compared?.url ?? fallbackUrl,
  };
}

function sinceLine(since: BaselineSince) {
  const short = since.sha.slice(0, 7);
  if (since.ahead === 0)
    return `上次在同一個 commit（${short}）通過，這次沒有新 commit 卻失敗，可能是測試不穩定或測試環境不同。`;
  return `上次通過是 ${short}，之後目標分支有${since.ahead === null ? "" : ` ${since.ahead} 個`}新 commit：${since.compareUrl}`;
}

/**
 * 目標分支基底驗證失敗時的說明（#248）：哪些測試失敗、各自的第一段錯誤訊息，以及上次通過的 commit。
 * 認不出測試格式、也沒有通過紀錄時回傳空字串，失敗說明照舊只挑輸出的錯誤行。
 */
export function baselineReport(output: string, since: BaselineSince | null = null) {
  const failures = parseTestFailures(output);
  return [
    ...(failures ? [describeTestFailures(failures)] : []),
    ...(since ? [sinceLine(since)] : []),
  ].join("\n");
}

const openStatuses = ["awaiting_approval", "queued", "running", "reviewing", "budget_wait"];

/**
 * 從基底驗證失敗的任務建立「修復目標分支」任務（#248）。需求自動帶入失敗的測試與錯誤訊息；
 * 一樣要等人工確認專案、分支並核准才會開始。同一專案、同一分支已有未結束的修復任務時直接回傳那一筆。
 */
export async function createBaselineRepair(db: Database, id: string, actor: string) {
  return db.transaction(async (c) => {
    const parent = (
      await c.query<Task>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!parent) throw new AppError(404, "找不到任務");
    const failure = parseFailure(parent.last_error);
    if (
      parent.status !== "failed" ||
      parent.mode !== "change" ||
      failure?.plain !== baselineFailurePlain ||
      !parent.target_branch
    )
      throw new AppError(409, "只有因目標分支基底驗證失敗而停下的修改，才能請 AI 修好目標分支");
    const usable = (
      await c.query<{ binding_version: number }>(
        `SELECT g.binding_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id JOIN groups g ON g.id=gp.group_id
         WHERE p.id=$1 AND g.id=$2 AND p.enabled AND p.validated_at IS NOT NULL AND g.left_at IS NULL FOR SHARE OF p`,
        [parent.project_id, parent.group_id],
      )
    ).rows[0];
    if (!usable)
      throw new AppError(409, "這個專案已停用或不再綁定此群組，請到專案頁處理");
    const existing = (
      await c.query<Task>(
        "SELECT * FROM tasks WHERE baseline_repair AND project_id=$1 AND target_branch=$2 AND status=ANY($3::text[]) ORDER BY created_at LIMIT 1",
        [parent.project_id, parent.target_branch, openStatuses],
      )
    ).rows[0];
    if (existing) return existing;
    const branch = parent.target_branch;
    const t = (
      await c.query<Task>(
        `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,risk_reasons,missing,source_ids,status,dedupe_key,suggestions,mode,discord_thread_id,baseline_repair,target_branch)
         VALUES($1,$2,$3,$4,$5,'[]','[]','{}','awaiting_approval',$6,'[]','change',$7,true,$8) RETURNING *`,
        [
          parent.project_id,
          parent.group_id,
          `修復目標分支 ${branch}`.slice(0, 120),
          `目標分支「${branch}」在修改前就有建置或測試沒有通過，請找出原因並修好，讓完整測試全部通過。\n${failure.detail}`,
          JSON.stringify([
            "完整測試全部通過，包含修改前就失敗的測試",
            "不刪除、略過、停用或放寬任何測試，也不改測試命令",
          ]),
          `baseline-repair:${parent.id}:${randomUUID()}`,
          parent.discord_thread_id ?? null,
          branch,
        ],
      )
    ).rows[0];
    const routing = {
      status: "clear",
      basis: "followup",
      reason: `修復「${parent.title}」遇到的目標分支建置或測試失敗，沿用同一個專案與分支`,
      evidence: [],
      bindingVersion: usable.binding_version,
      followupOf: { id: parent.id, title: parent.title },
    };
    await c.query(
      "UPDATE tasks SET project_routing=$2,branch_selection=$3 WHERE id=$1",
      [
        t.id,
        JSON.stringify(routing),
        JSON.stringify({
          basis: "followup",
          reason: `修復的是「${parent.title}」的目標分支「${branch}」`,
          sourceIds: [],
        }),
      ],
    );
    await c.query(
      "INSERT INTO task_versions(task_id,version,summary,acceptance) VALUES($1,1,$2,$3)",
      [t.id, t.summary, JSON.stringify(t.acceptance)],
    );
    await db.audit(
      t.id,
      "baseline_repair",
      `${actor} 從「${parent.title}」請 AI 修好目標分支 ${branch}，等待確認`,
      c,
    );
    const created = (await c.query<Task>("SELECT * FROM tasks WHERE id=$1", [t.id])).rows[0];
    await approvalNotice(c, created);
    return created;
  });
}
