import type { Database } from "./db.js";
import type { GitHub } from "./github.js";
import type { Project } from "../shared/types.js";
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
