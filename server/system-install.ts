import type { Database } from "./db.js";
import type { Runner } from "./execution.js";
import type { Project } from "../shared/types.js";
import type { SetupPlan } from "../shared/project-setup.js";
import { redact } from "./policy.js";
import { approvedItems } from "./install-review.js";
import { egressDomains, type InstallReport } from "../shared/install-plan.js";

interface DerivedResult {
  image: string | null;
  reused: boolean;
  planHash: string;
  exitCode: number;
  output: string;
}

/**
 * 依專案設定的安裝前審查結果準備專案衍生映像：放行的系統套件由執行器以 root 安裝，
 * 同專案、同分支、同安裝計畫、同基底映像時直接重用。回傳的報告寫進執行紀錄與稽核，
 * 任務詳情據此顯示「裝了什麼、為什麼、誰放行」。沒有安裝計畫時回傳 null。
 */
export async function provideSystemInstall(
  db: Database,
  runner: Runner,
  input: {
    runId: string;
    taskId: string | null;
    /** 基底映像（已套用 SQL Server 自動選用）。 */
    project: Pick<Project, "id" | "name" | "image">;
    plan: SetupPlan | null | undefined;
    timeoutMs: number;
  },
): Promise<(InstallReport & { output: string }) | null> {
  const review = input.plan?.systemInstall;
  if (!review) return null;
  const items = approvedItems(review);
  const base = input.project.image;
  let report: InstallReport & { output: string };
  if (!items.length)
    report = { image: null, base, reused: false, review, output: "" };
  else {
    const result = await runner.call<DerivedResult>(
      "derived-image",
      {
        runId: input.runId,
        image: base,
        projectId: input.project.id,
        branch: input.plan!.branch,
        items,
        domains: egressDomains(await db.settings()),
        timeoutMs: input.timeoutMs,
      },
      input.timeoutMs,
    );
    const output = redact(result.output ?? "").slice(-4000);
    report = result.image
      ? { image: result.image, base, reused: result.reused, review, output }
      : {
          image: null,
          base,
          reused: false,
          review,
          output,
          error: `系統套件安裝失敗（退出碼 ${result.exitCode}）`,
        };
    if (result.image) {
      // 最後使用時間給 Docker 磁碟管理判斷「多久沒用」；預設不自動刪。
      await db.query(
        `INSERT INTO derived_images(tag,project_id,branch,plan_hash,base_image,items,last_used_at)
         VALUES($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT(tag) DO UPDATE SET last_used_at=now(),project_id=EXCLUDED.project_id`,
        [
          result.image,
          input.project.id,
          input.plan!.branch,
          result.planHash,
          base,
          JSON.stringify(items),
        ],
      );
    }
  }
  const { output: _output, ...saved } = report;
  await db.query("UPDATE runs SET install_report=$2 WHERE id=$1", [
    input.runId,
    JSON.stringify(saved),
  ]);
  const names = items.map((i) => i.name).join("、");
  await db.audit(
    input.taskId,
    "install_image",
    report.image
      ? `${report.reused ? "重用" : "建立"}專案 ${input.project.name} 的衍生映像 ${report.image}（${names}；${review.reviewer}放行）${report.reused ? "，沒有重新下載" : ""}`
      : report.error
        ? `專案 ${input.project.name} 的${report.error}：${output(report.output)}`
        : `專案 ${input.project.name} 的系統套件安裝計畫全部被拒絕，使用原本的工作映像`,
  );
  return report;
}

const output = (text: string) => text.slice(-300).trim() || "沒有輸出";

/** 交給 Codex 與報告的白話說明：可用的系統工具與被拒絕的項目。 */
export function systemInstallNote(report: InstallReport | null) {
  if (!report) return null;
  const installed = report.image
    ? report.review.decisions.filter((d) => d.approved)
    : [];
  const rejected = report.review.decisions.filter((d) => !d.approved);
  return {
    installed: installed.map(
      (d) => `${d.name}${d.version ? ` ${d.version}` : ""}：${d.purpose}`,
    ),
    rejected: rejected.map((d) => `${d.name}：${d.reason}`),
    ...(report.error ? { error: report.error } : {}),
  };
}
