import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Project } from "../shared/types.js";
import {
  emptyContext,
  type InputQuestion,
  type ProjectInputRequest,
} from "../shared/project-context.js";
import { AppError, redact } from "./policy.js";
import { requireAdmin } from "./auth.js";
import { Database } from "./db.js";

// 不把常見憑證格式存入長期資訊。錯誤訊息不回顯輸入值。
export function assertContextText(text: string) {
  if (
    redact(text) !== text ||
    /(?:password|passwd|pwd|secret|token|api[_ -]?key|密碼|驗證碼|一次性密碼)\s*[=:：]\s*\S+|-----BEGIN [^-]*PRIVATE KEY-----|:\/\/[^\s/:]+:[^\s/@]+@|^\s*\d{6,8}\s*$/im.test(
      text,
    )
  )
    throw new AppError(
      422,
      "請勿在專案資訊或回覆填入密碼、金鑰或驗證碼。請在對應服務完成登入／驗證，再回來繼續。",
    );
}
const field = z.string().trim().max(4000);
export const ContextSchema = z.object({
  purpose: field,
  branches: field,
  environment: field,
  testing: field,
  constraints: field,
  notes: z.string().trim().max(10000),
});
export const QuestionSchema = z.object({
  kind: z.enum(["information", "authentication"]),
  question: z.string().min(1).max(1000),
});
export class NeedsProjectInput extends AppError {
  constructor(
    message: string,
    public questions: InputQuestion[] = [],
    public details?: string,
  ) {
    super(422, message);
    if (!questions.length)
      this.questions = [{ kind: "information", question: message }];
  }
}

/** 使用明確前綴，避免把一般報告中的範例誤當成補問。 */
export function taskInputQuestions(final: string): InputQuestion[] | null {
  const marker = "AGENTFLOW_NEEDS_INPUT:";
  if (!final.trimStart().startsWith(marker)) return null;
  const value = final.trimStart().slice(marker.length).trim();
  let parsed: { questions: InputQuestion[] };
  try {
    parsed = z
      .object({ questions: z.array(QuestionSchema).min(1).max(5) })
      .parse(JSON.parse(value));
  } catch {
    throw new AppError(422, "AI 的補問格式不完整，已停止執行，請重新檢視需求");
  }
  for (const q of parsed.questions) {
    try {
      assertContextText(q.question);
    } catch {
      q.kind = "authentication";
      q.question =
        "請在對應服務本身完成登入或驗證；不要在看板填入驗證碼、密碼或金鑰。";
    }
    if (q.kind === "authentication")
      q.question += " 請在服務本身完成，不要貼上驗證碼。";
  }
  return parsed.questions;
}

/** 問題與通知一起發布；舊版執行不能覆寫新版設定。等待期間不占用容器。 */
export async function requestProjectInput(
  db: Database,
  project: Project,
  error: NeedsProjectInput,
) {
  const request: ProjectInputRequest = {
    id: randomUUID(),
    configVersion: project.config_version,
    reason: redact(error.message),
    ...(error.details ? { details: redact(error.details) } : {}),
    questions: error.questions
      .slice(0, 5)
      .map((q) => ({ ...q, question: redact(q.question) })),
    createdAt: new Date().toISOString(),
  };
  // 來源可能是模型輸出；偵測到憑證時只保留通用引導。
  try {
    assertContextText(JSON.stringify(request));
  } catch {
    request.reason = "需要在外部服務完成驗證";
    request.questions = [
      {
        kind: "authentication",
        question: "請到對應服務完成登入或驗證，再回來繼續；不要貼上驗證碼。",
      },
    ];
  }
  await db.transaction(async (c) => {
    const changed = await c.query(
      "UPDATE projects SET setup_input=$3,validated_at=NULL,enabled=false,setup_plan=NULL,setup_status='等待你補充資訊',validation_error=NULL WHERE id=$1 AND config_version=$2 AND setup_input IS NULL RETURNING id",
      [project.id, project.config_version, JSON.stringify(request)],
    );
    if (!changed.rowCount) return;
    await c.query(
      "INSERT INTO notifications(kind,dedupe_key,text) VALUES('project_input',$1,$2) ON CONFLICT DO NOTHING",
      [
        `project-input:${request.id}`,
        `專案「${project.name}」（${project.repo}）需要你補充資訊。\n${request.questions.map((q, i) => `${i + 1}. ${q.question.slice(0, 300)}`).join("\n")}\n請到看板的專案資訊回覆完整問題；登入或驗證碼請在服務本身完成。`,
      ],
    );
  });
}

export function registerProjectContext(
  app: FastifyInstance,
  db: Database,
  enqueue?: (id: string) => Promise<unknown>,
) {
  app.put("/api/projects/:id/context", async (req, reply) => {
    const actor = await requireAdmin(db, req);
    reply.header("Cache-Control", "no-store");
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const body = z
      .object({
        configVersion: z.number().int().positive(),
        context: ContextSchema,
        requestId: z.string().uuid().optional(),
        answers: z.array(z.string().trim().min(1).max(2000)).max(5).optional(),
        validate: z.boolean().default(false),
      })
      .parse(req.body);
    for (const value of [
      ...Object.values(body.context),
      ...(body.answers ?? []),
    ])
      assertContextText(value);
    if (body.validate && !enqueue)
      throw new AppError(503, "工作佇列尚未啟動，資料尚未儲存");
    const saved = await db.transaction(async (c) => {
      const old = (
        await c.query<Project>(
          "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new AppError(404, "找不到專案");
      if (old.config_version !== body.configVersion)
        throw new AppError(
          409,
          "專案資料已更新，請重新檢視後再儲存；你的草稿仍保留",
        );
      if (body.requestId) {
        const pending = old.setup_input;
        if (
          !pending ||
          pending.id !== body.requestId ||
          pending.configVersion !== body.configVersion
        )
          throw new AppError(409, "這次問題已失效，請重新整理");
        if (!body.answers || body.answers.length !== pending.questions.length)
          throw new AppError(422, "請逐項回答；不知道的部分可以明確寫尚未確認");
        // 登入完成只是使用者回報，不能當成驗證成功，也不保存一次性代碼。
        pending.questions.forEach((q, i) => {
          if (
            q.kind === "authentication" &&
            body.answers![i] !== "已在服務完成驗證"
          )
            throw new AppError(
              422,
              "請在服務本身完成驗證，再勾選已完成；不要輸入驗證碼",
            );
        });
        body.context.notes = [
          body.context.notes,
          ...pending.questions.map(
            (q, i) => `${q.question}\n回覆：${body.answers![i]}`,
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
        ContextSchema.parse(body.context);
      } else if (body.answers) throw new AppError(422, "回覆必須對應目前問題");
      const changed =
        JSON.stringify({ ...emptyContext, ...old.project_context }) !==
          JSON.stringify(body.context) || !!body.requestId;
      if (!changed) return old;
      const row = (
        await c.query<Project>(
          "UPDATE projects SET project_context=$2,context_updated_at=now(),context_updated_by=$3,config_version=config_version+1,validated_at=NULL,enabled=false,setup_plan=NULL,setup_input=NULL,setup_status='專案資訊已更新，等待重新驗證',validation_error=NULL WHERE id=$1 RETURNING *",
          [id, JSON.stringify(body.context), actor.login],
        )
      ).rows[0];
      await db.audit(
        null,
        "project_context",
        `已更新專案「${old.name}」資訊（設定版本 ${row.config_version}）`,
        c,
      );
      return row;
    });
    // 儲存已完成；排程失敗要清楚告知可重試，不讓使用者重複提交同一份答案。
    if (body.validate) {
      try {
        await enqueue!(id);
      } catch {
        return {
          project: saved,
          queued: false,
          message: "資訊已儲存，但排程未成功。請按重新驗證。",
        };
      }
    }
    return { project: saved, queued: body.validate };
  });
}
