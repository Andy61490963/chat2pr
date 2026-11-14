import { createFollowupInTransaction, threadOf } from "./followup.js";
import { withAssumptions } from "../shared/clarification.js";
import { referencedSources } from "./retrieval.js";
import { taskImageEvidence } from "./image-context.js";
import { readReportImages } from "./query-report.js";
import { readTaskContextEvidence } from "./task-context.js";
import { memberNames } from "./line-members.js";
import { z } from "zod";
import {
  requireProjectConfirmation,
  saveProjectConfirmation,
} from "./project-routing.js";
import { Database } from "./db.js";
import { GitHub } from "./github.js";
import { TargetBranch } from "./task-branch.js";
import { AppError, assertTransition } from "./policy.js";
import { assertContextText } from "./project-context.js";
import { notifyGroup } from "./group-replies.js";
import type { Action, Project, Task } from "../shared/types.js";
export const Assignment = z.object({
  project_id: z.string().uuid(),
  remember: z.string().trim().max(1000).optional(),
});
export const Amendment = z.object({
  summary: z.string().min(5).max(15000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(30),
});
// 時間軸寫明做了什麼，不只寫「操作」。
export const actionLabels: Record<string, string> = {
  approve: "核准",
  reject: "拒絕",
  cancel: "取消",
  retry: "重試",
  amend: "補充需求",
  assumption: "修改假設",
  assign: "指定專案",
  adopt: "採用方案",
  mode: "切換任務類型",
  target: "更換目標分支",
  reopen: "重新開啟",
};
export class Tasks {
  constructor(private db: Database) {}
  /** 向 GitHub 確認要換的分支存在；回傳確認時看到的儲存庫與分支，交易內再核對一次。 */
  private async checkTarget(id: string, version: number, body: unknown) {
    const wanted = z.object({ target_branch: TargetBranch }).safeParse(body);
    const p = await this.db.one<Project & { task_version: number }>(
      "SELECT p.*,t.version AS task_version FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=$1",
      [id],
    );
    // 格式不對、找不到或版本過期的請求由交易內的檢查回覆，不必先問 GitHub。
    if (!wanted.success || !p || p.task_version !== version) return null;
    const branch = wanted.data.target_branch;
    await new GitHub().base({ ...p, base_branch: branch });
    return { repo: p.repo, branch };
  }
  async action(
    id: string,
    action: Action,
    version: number,
    actor: string,
    body: unknown = {},
    channel: "dashboard" | "internal" = "internal",
  ) {
    // 更換分支要先問 GitHub 分支在不在。這一步放在交易之外，
    // GitHub 回應慢時才不會一直握著任務與專案的鎖，卡住同一筆任務的其他操作。
    const checked =
      action === "target" && channel === "dashboard"
        ? await this.checkTarget(id, version, body)
        : null;
    return this.db.transaction(async (c) => {
      // 與綁定、專案設定異動採相同鎖定順序，避免核准舊畫面。
      await c.query(
        "SELECT g.id FROM groups g JOIN tasks t ON t.group_id=g.id WHERE t.id=$1 FOR SHARE OF g",
        [id],
      );
      await c.query(
        "SELECT p.id FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=$1 FOR SHARE OF p",
        [id],
      );
      const t = (
        await c.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id])
      ).rows[0] as Task | undefined;
      if (!t) throw new AppError(404, "找不到任務");
      if (t.version !== version)
        throw new AppError(409, "需求版本已更新，請重新檢視");
      assertTransition(t.status, action);
      if (["approve", "adopt", "target"].includes(action)) {
        if (channel !== "dashboard")
          throw new AppError(409, "請到看板確認目標專案後核准");
        const seen = z
          .object({
            project_id: z.string().uuid(),
            binding_version: z.number().int().positive(),
            config_version: z.number().int().positive(),
            target_branch: TargetBranch,
          })
          .safeParse(body);
        if (!seen.success)
          throw new AppError(409, "請重新開啟看板並確認目標專案");
        const current = (
          await c.query(
            "SELECT g.binding_version,p.config_version FROM groups g JOIN group_projects gp ON gp.group_id=g.id JOIN projects p ON p.id=gp.project_id WHERE g.id=$1 AND p.id=$2",
            [t.group_id, t.project_id],
          )
        ).rows[0];
        if (
          !current ||
          t.project_id !== seen.data.project_id ||
          (action !== "target" &&
            t.target_branch !== seen.data.target_branch) ||
          current.binding_version !== seen.data.binding_version ||
          current.config_version !== seen.data.config_version
        )
          throw new AppError(409, "目標專案或綁定已變更，請重新檢視");
      }
      if (
        [
          "approve",
          "adopt",
          "assign",
          "mode",
          "amend",
          "assumption",
          "target",
          "reopen",
        ].includes(action) &&
        (
          await c.query(
            "SELECT 1 FROM runs WHERE task_id=$1 AND completed_at IS NULL",
            [id],
          )
        ).rowCount
      )
        throw new AppError(409, "先前執行尚未完成清理，請稍後再確認");
      if (action === "approve") {
        if (!t.project_id)
          throw new AppError(409, "請先指定要修改的專案，再核准");
        if (t.missing.length || t.question)
          throw new AppError(409, "請先補充缺漏資訊與驗收條件，再核准");
        await c.query(
          "UPDATE tasks SET status='queued',approved_version=version,approved_paths=pending_paths,last_error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
        await c.query(
          "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,version) DO UPDATE SET approved_by=$5",
          [id, version, t.summary, JSON.stringify(t.acceptance), actor],
        );
      } else if (action === "adopt") {
        // 採用 AI 建議方案：存成新需求版本並直接核准，等同補充後核准。
        const { index } = z
          .object({ index: z.number().int().min(0).max(2) })
          .parse(body);
        const s = t.suggestions[index];
        if (!s) throw new AppError(404, "找不到這個建議方案");
        if (t.mode === "query" || t.question)
          throw new AppError(409, "請先補充必要資訊，查詢不採用開發方案");
        if (!t.project_id)
          throw new AppError(409, "請先指定要修改的專案，再採用方案");
        if (t.risk_reasons.length)
          throw new AppError(409, "此需求涉及敏感範圍，請在看板確認後核准");
        await c.query(
          "UPDATE tasks SET summary=$2,acceptance=$3,missing='[]',question=NULL,suggestions='[]',version=version+1,approved_version=version+1,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,status='queued',last_error=NULL,updated_at=now() WHERE id=$1",
          [
            id,
            withAssumptions(`${s.label}：${s.summary}`, t.assumptions ?? []),
            JSON.stringify(s.acceptance),
          ],
        );
        await c.query(
          "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) SELECT id,version,summary,acceptance,$2 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING",
          [id, actor],
        );
      } else if (action === "target") {
        const { target_branch } = z
          .object({ target_branch: TargetBranch })
          .parse(body);
        const p = (
          await c.query("SELECT * FROM projects WHERE id=$1", [t.project_id])
        ).rows[0] as Project;
        // 只認交易前對同一個儲存庫、同一個分支做過的確認。
        if (checked?.repo !== p.repo || checked.branch !== target_branch)
          throw new AppError(409, "目標專案或綁定已變更，請重新檢視");
        await c.query(
          "UPDATE tasks SET target_branch=$2,branch_selection=$3,version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,issue_version=NULL,pr_number=NULL,pr_url=NULL,status='awaiting_approval',last_error=NULL,updated_at=now() WHERE id=$1",
          [
            id,
            target_branch,
            JSON.stringify({
              basis: "manual",
              reason: `已選擇目標分支「${target_branch}」，請確認需求、專案與分支`,
              sourceIds: [],
            }),
          ],
        );
      } else if (action === "assign") {
        const a = Assignment.parse(body);
        const bound = await c.query(
          "SELECT 1 FROM group_projects WHERE group_id=$1 AND project_id=$2",
          [t.group_id, a.project_id],
        );
        if (!bound.rowCount) throw new AppError(409, "此群組未綁定該專案");
        await c.query(
          "UPDATE tasks SET project_id=$2,version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,issue_number=NULL,issue_url=NULL,issue_version=NULL,status='awaiting_approval',updated_at=now() WHERE id=$1",
          [id, a.project_id],
        );
        await c.query(
          "INSERT INTO task_versions(task_id,version,summary,acceptance) SELECT id,version,summary,acceptance FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING",
          [id],
        );
        // 管理者指定時可一併記住，之後同類需求由 AI 直接選對專案。
        if (a.remember)
          await c.query(
            "INSERT INTO group_memories(group_id,project_id,content,source) VALUES($1,$2,$3,'admin')",
            [t.group_id, a.project_id, a.remember],
          );
      } else if (action === "mode") {
        // 類型切換是新需求版本，不能把查詢的自動核准帶入修改任務。
        const { mode } = z
          .object({ mode: z.enum(["change", "query"]) })
          .parse(body);
        await c.query(
          "UPDATE tasks SET mode=$2,version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,status='awaiting_approval',updated_at=now() WHERE id=$1",
          [id, mode],
        );
      } else if (action === "assumption") {
        const a = z
          .object({
            index: z.number().int().min(0),
            value: z.string().trim().min(1).max(500),
          })
          .parse(body);
        assertContextText(a.value);
        const previous = t.assumptions ?? [];
        if (a.index >= previous.length)
          throw new AppError(409, "這項假設已不存在，請重新檢視");
        if (previous[a.index] === a.value)
          throw new AppError(422, "請先修改假設內容");
        const assumptions = previous.map((value, index) =>
          index === a.index ? a.value : value,
        );
        const summary = withAssumptions(t.summary, assumptions, previous);
        if (summary.length > 15000)
          throw new AppError(422, "需求內容過長，請縮短假設內容");
        if (t.mode === "query" && t.status === "answered") {
          const child = await createFollowupInTransaction(
            this.db,
            c,
            t,
            summary,
            actor,
            {
              assumptions,
              acceptance: t.acceptance,
              riskText: a.value,
              // 新題沿用整份需求，原本需人工確認的風險不能因只改假設而消失。
              retainedRisk: t.risk_reasons[0],
            },
          );
          await this.db.audit(
            child.id,
            "assumption_changed",
            `${actor} 將假設「${previous[a.index]}」改為「${a.value}」，建立追問並保留原回答`,
            c,
          );
          return child;
        }
        await c.query(
          "UPDATE tasks SET summary=$2,assumptions=$3,suggestions='[]',version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,status='awaiting_approval',last_error=NULL,updated_at=now() WHERE id=$1",
          [id, summary, JSON.stringify(assumptions)],
        );
        await this.db.audit(
          id,
          "assumption_changed",
          `${actor} 將假設「${previous[a.index]}」改為「${a.value}」`,
          c,
        );
      } else if (action === "amend") {
        const a = Amendment.parse(body);
        if (t.last_error?.startsWith("AI 等你回答")) {
          assertContextText(a.summary);
          for (const value of a.acceptance) assertContextText(value);
          if (
            a.summary === t.summary &&
            JSON.stringify(a.acceptance) === JSON.stringify(t.acceptance)
          )
            throw new AppError(422, "請先在需求中補充回答，再重新確認");
        }
        await c.query(
          "UPDATE tasks SET summary=$2,acceptance=$3,missing='[]',question=NULL,assumptions='[]',suggestions='[]',version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,status='awaiting_approval',last_error=NULL,updated_at=now() WHERE id=$1",
          [id, a.summary, JSON.stringify(a.acceptance)],
        );
        await c.query(
          "INSERT INTO task_versions(task_id,version,summary,acceptance) SELECT id,version,summary,acceptance FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING",
          [id],
        );
      } else if (action === "reopen") {
        // 重新開啟是新需求版本：先前的核准與專案確認都不沿用，一律重新審核。
        await c.query(
          "UPDATE tasks SET version=version+1,approved_version=NULL,approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,status='awaiting_approval',last_error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
      } else if (action === "retry") {
        await requireProjectConfirmation(c, id);
        if (t.approved_version !== t.version)
          throw new AppError(409, "此版本尚未核准");
        if (
          (
            await c.query(
              "SELECT id FROM runs WHERE task_id=$1 AND completed_at IS NULL",
              [id],
            )
          ).rowCount
        )
          throw new AppError(409, "先前執行尚未完成清理");
        await c.query(
          "UPDATE tasks SET status='queued',last_error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
      } else {
        await c.query(
          "UPDATE tasks SET status=$2,updated_at=now() WHERE id=$1",
          [id, action === "reject" ? "rejected" : "cancelled"],
        );
        await notifyGroup(
          c,
          id,
          "closed",
          `closed:${id}:${t.version}`,
          `「${t.title}」${action === "reject" ? "管理者決定不處理" : "已由管理者取消"}。`,
        );
      }
      // 分支功能上線前就結束的任務沒有記錄目標分支。回到待審核時帶入專案預設分支並標成待確認，
      // 不會停在「尚未選擇」。待審核中分支消失的任務不在此列，仍要由人重新選。
      if (
        !t.target_branch &&
        (action === "reopen" || (action === "amend" && t.status === "answered"))
      )
        await c.query(
          "UPDATE tasks t SET target_branch=p.base_branch,branch_selection=$2 FROM projects p WHERE t.id=$1 AND p.id=t.project_id AND t.target_branch IS NULL",
          [
            id,
            JSON.stringify({
              basis: "uncertain",
              reason:
                "這筆任務先前沒有記錄目標分支，已帶入專案預設分支，請確認",
              sourceIds: [],
            }),
          ],
        );
      const result = (await c.query("SELECT * FROM tasks WHERE id=$1", [id]))
        .rows[0] as Task;
      if (["approve", "adopt"].includes(action))
        await saveProjectConfirmation(c, result, "manual", actor);
      if (
        ["assign", "amend", "assumption", "mode", "target", "reopen"].includes(
          action,
        )
      ) {
        await c.query(
          "UPDATE tasks SET project_routing=jsonb_build_object('status','uncertain','basis','none','reason',$2::text,'evidence','[]'::jsonb,'bindingVersion',0) WHERE id=$1",
          [id, "需求或目標已調整，請重新確認本次處理專案"],
        );
        await c.query(
          "INSERT INTO task_versions(task_id,version,summary,acceptance) SELECT id,version,summary,acceptance FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING",
          [id],
        );
      }
      await this.db.audit(
        id,
        action,
        `${actor} ${actionLabels[action] ?? "操作"}（需求版本 ${version}；目標分支 ${result.target_branch ?? "待選擇"}）`,
        c,
      );
      return (await c.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0];
    });
  }
  async branches(id: string) {
    const task = await this.db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      id,
    ]);
    if (!task) throw new AppError(404, "找不到任務");
    const project = await this.db.one<Project>(
      "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id=$1 AND p.id=$2",
      [task.group_id, task.project_id],
    );
    if (!project) throw new AppError(409, "請先選擇群組已綁定的專案");
    return {
      ...(await new GitHub().branches(project)),
      version: task.version,
      projectId: project.id,
      configuredBranch: project.base_branch,
    };
  }
  async detail(id: string) {
    const task = await this.db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      id,
    ]);
    if (!task) throw new AppError(404, "找不到任務");
    const [rawSources, history, runs] = await Promise.all([
      this.db.query<{
        user_id: string | null;
        sender: string | null;
        [key: string]: unknown;
      }>(
        `SELECT id,type,CASE WHEN received_at>message_retention_cutoff() AND NOT revoked THEN text ELSE NULL END AS text,quoted_id,received_at,(revoked OR received_at<=message_retention_cutoff()) AS revoked,(image IS NOT NULL AND NOT revoked AND received_at>message_retention_cutoff()) AS has_image,
          CASE WHEN NOT revoked AND received_at>message_retention_cutoff() AND user_id IS NOT NULL THEN '成員 '||left(md5(group_id||':'||user_id),6) END AS sender,
          CASE WHEN NOT revoked AND received_at>message_retention_cutoff() THEN user_id END AS user_id
          FROM messages WHERE group_id=$1 AND id=ANY($2) ORDER BY received_at`,
        [task.group_id, task.source_ids],
      ),
      this.db.query(
        "SELECT * FROM audit WHERE task_id=$1 ORDER BY created_at,id",
        [id],
      ),
      this.db.query(
        "SELECT r.id,version,status,outcome,observed,model,started_at,completed_at,heartbeat_at,deadline,install_report,COALESCE((SELECT jsonb_agg(jsonb_build_object('phase',e.phase,'threadId',e.thread_id) ORDER BY e.id) FROM run_events e WHERE e.run_id=r.id AND e.kind='thread'),'[]') AS threads FROM runs r WHERE task_id=$1 ORDER BY started_at DESC LIMIT 50",
        [id],
      ),
    ]);
    // 來源訊息顯示是誰說的；LINE 使用者 ID 只在伺服器端查名稱，不回傳給瀏覽器。
    const names = await memberNames(
      this.db,
      task.group_id,
      rawSources.flatMap((m) => (m.user_id ? [m.user_id] : [])),
    );
    const sources = rawSources.map(({ user_id, ...m }) => ({
      ...m,
      sender: (user_id && names.get(user_id)) || m.sender,
    }));
    return {
      task,
      projectReview: await this.db.one(
        `SELECT g.binding_version,p.config_version,p.name AS project_name,p.repo,p.base_branch,g.name AS group_name,task_project_confirmed(t.id) AS confirmed,
         (SELECT row_to_json(a) FROM task_project_confirmations a WHERE a.task_id=t.id AND a.version=t.version) AS confirmation
         FROM tasks t JOIN groups g ON g.id=t.group_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=$1`,
        [id],
      ),
      sources,
      history,
      runs,
      images: await taskImageEvidence(this.db, id, task.version),
      reportImages: await readReportImages(this.db, id),
      contextEvidence: await readTaskContextEvidence(this.db, id),
      references: await referencedSources(this.db, id, task.group_id),
      thread: await threadOf(this.db, task),
    };
  }
  async runEvents(taskId: string, runId: string, before?: number) {
    const run = await this.db.one(
      "SELECT id FROM runs WHERE id=$1 AND task_id=$2",
      [runId, taskId],
    );
    if (!run) throw new AppError(404, "找不到這次執行");
    const rows = await this.db.query<{ seq: number }>(
      `SELECT id::int AS seq,at,phase,kind,
      CASE WHEN run_content_visible(run_id) THEN detail ELSE NULL END AS detail,
      thread_id AS "threadId",container_id AS "containerId",exit_code AS "exitCode"
      FROM run_events WHERE run_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 201`,
      [runId, before ?? null],
    );
    const hasOlder = rows.length > 200;
    const events = rows.slice(0, 200).reverse();
    return { events, hasOlder, nextBefore: hasOlder ? events[0].seq : null };
  }
}
