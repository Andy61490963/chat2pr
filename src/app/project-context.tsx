import { useEffect, useState } from "react";
import type { Project } from "../../shared/types.js";
import {
  contextFields,
  emptyContext,
  type ProjectContext,
} from "../../shared/project-context.js";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import { useUnsaved } from "./unsaved";
import { date, type Request, type Run } from "./shared";

export function ProjectContextEditor({
  project,
  busy,
  request,
  run,
}: {
  project: Project;
  busy: boolean;
  request: Request;
  run: Run;
}) {
  const snapshot = JSON.stringify({
    ...emptyContext,
    ...project.project_context,
  });
  const [base, setBase] = useState(snapshot);
  const [version, setVersion] = useState(project.config_version);
  const [draft, setDraft] = useState<ProjectContext>(() =>
    JSON.parse(snapshot),
  );
  const [answers, setAnswers] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(draft) !== base || answers.some(Boolean);
  useUnsaved(`project-context:${project.id}`, dirty);
  useEffect(() => {
    // 背景更新不可洗掉草稿；保留原版本讓後端攔下過期儲存。
    if (!dirty && project.config_version > version) {
      setBase(snapshot);
      setDraft(JSON.parse(snapshot));
      setVersion(project.config_version);
    }
  }, [snapshot, project.config_version, version, dirty]);
  const pending = project.setup_input;
  useEffect(() => {
    setAnswers([]);
  }, [pending?.id]);
  const submit = (validate: boolean, respond = false) =>
    void run(async () => {
      const result = await request<{
        project: Project;
        queued: boolean;
        message?: string;
      }>(`/api/projects/${project.id}/context`, "PUT", {
        configVersion: version,
        context: draft,
        validate,
        ...(respond ? { requestId: pending?.id, answers } : {}),
      });
      const value = { ...emptyContext, ...result.project.project_context };
      setDraft(value);
      setBase(JSON.stringify(value));
      setVersion(result.project.config_version);
      setAnswers([]);
      setNotice(
        result.message ??
          (result.queued
            ? "已儲存並排程驗證，請留意上方進度。"
            : "已儲存；重新驗證通過後才會啟用派工。"),
      );
    }, "專案資訊已儲存");
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-label="專案資訊與環境"
    >
      <div>
        <h3 className="font-medium">專案資訊與環境</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          AI
          會先自行安裝套件、準備可用的測試環境；缺少只有你知道的資訊才會詢問。不會自動寫入
          Git。請勿填入帳密、金鑰或驗證碼。
        </p>
        {project.context_updated_at && (
          <p className="mt-1 text-xs text-muted-foreground">
            {project.context_updated_by} 更新於{" "}
            {date(project.context_updated_at)} · 設定版本{" "}
            {project.config_version}
          </p>
        )}
      </div>
      {pending && (
        <div className="space-y-3 rounded-lg bg-warn-soft p-3" role="status">
          <h4 className="font-medium">還需要你提供一點資訊</h4>
          <p className="text-sm whitespace-pre-wrap">
            {pending.reason.length > 240
              ? "測試環境還缺少必要資訊，補充後 AI 會繼續準備。"
              : pending.reason}
          </p>
          {(pending.details || pending.reason.length > 240) && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                查看已檢查項目與技術細節
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words">
                {pending.details || pending.reason}
              </p>
            </details>
          )}
          {pending.questions.map((q, i) => (
            <div className="space-y-2" key={`${pending.id}-${i}`}>
              <Label htmlFor={`context-answer-${i}`}>
                {i + 1}. {q.question}
              </Label>
              {q.kind === "authentication" ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    請自行開啟對應服務完成登入或輸入驗證碼。此處只回報完成狀態，系統仍會重新檢查是否可用。
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`context-answer-${i}`}
                      checked={answers[i] === "已在服務完成驗證"}
                      onCheckedChange={(checked) =>
                        setAnswers((a) =>
                          pending.questions.map((_, n) =>
                            n === i
                              ? checked === true
                                ? "已在服務完成驗證"
                                : ""
                              : (a[n] ?? ""),
                          ),
                        )
                      }
                    />
                    已在服務完成驗證
                  </label>
                </>
              ) : (
                <Textarea
                  id={`context-answer-${i}`}
                  rows={3}
                  maxLength={2000}
                  value={answers[i] ?? ""}
                  placeholder="用平常說話的方式回答即可；不知道也可以直接寫「不知道」"
                  onChange={(e) =>
                    setAnswers((a) =>
                      pending.questions.map((_, n) =>
                        n === i ? e.target.value : (a[n] ?? ""),
                      ),
                    )
                  }
                />
              )}
            </div>
          ))}
          <Button
            disabled={
              busy || pending.questions.some((_, i) => !answers[i]?.trim())
            }
            onClick={() => submit(true, true)}
          >
            送出回答並繼續驗證
          </Button>
        </div>
      )}
      {(
        Object.entries(contextFields) as [
          keyof ProjectContext,
          { label: string; hint: string },
        ][]
      ).map(([key, info]) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`context-${key}`}>{info.label}</Label>
          <Textarea
            id={`context-${key}`}
            rows={key === "notes" ? 4 : 3}
            maxLength={key === "notes" ? 10000 : 4000}
            value={draft[key]}
            placeholder={info.hint}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </div>
      ))}
      {version !== project.config_version && dirty && (
        <p className="text-sm text-warn">
          資料已被更新，你的草稿仍保留。請先複製需要保留的內容，再按「重新載入資料」檢視新版。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => submit(false)}
        >
          儲存資訊
        </Button>
        <Button disabled={busy || !!pending} onClick={() => submit(true)}>
          儲存並驗證環境
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(JSON.parse(snapshot));
            setBase(snapshot);
            setVersion(project.config_version);
            setAnswers([]);
          }}
        >
          重新載入資料
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        更新資訊會清除舊驗證，相關任務需重新確認；既有登入、網路與人工審核限制仍適用。
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
