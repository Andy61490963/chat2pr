import { useState } from "react";
import type { Task } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/form-controls";
import { useUnsaved } from "./unsaved";
import type { Act } from "./shared";

export function TaskClarification({
  task,
  editable,
  busy,
  act,
  amend,
  answer,
}: {
  task: Task;
  editable: boolean;
  busy: boolean;
  act: Act;
  amend: () => void;
  /** 直接回答補問；系統把回答併進需求。 */
  answer: (task: Task, text: string) => Promise<unknown>;
}) {
  const [reply, setReply] = useState("");
  useUnsaved("task-answer", reply.trim().length > 0);
  const [editing, setEditing] = useState<{
    index: number;
    value: string;
    version: number;
  } | null>(null);
  const assumptions = task.assumptions ?? [];
  const createsFollowup = task.mode === "query" && task.status === "answered";
  // 成功儲存後由伺服器版本與內容確認；失敗時保留輸入，背景更新時禁止覆寫新版本。
  const saved =
    editing &&
    task.version > editing.version &&
    assumptions[editing.index] === editing.value.trim();
  const draft = saved ? null : editing;
  const stale = !!draft && draft.version !== task.version;
  useUnsaved("task-assumption", !!draft);
  return (
    <>
      {task.question && (
        <section
          aria-label="需要你補充"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <h3 className="text-sm font-medium">需要你補充一件事</h3>
          <p className="text-sm">{task.question.text}</p>
          {task.question.choices.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="常見答案">
              {task.question.choices.map((choice) =>
                editable ? (
                  <Button
                    key={choice}
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => setReply(choice)}
                  >
                    {choice}
                  </Button>
                ) : (
                  <Badge key={choice} variant="secondary">
                    {choice}
                  </Badge>
                ),
              )}
            </div>
          )}
          {editable && (
            <form
              className="flex flex-col gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                await answer(task, reply.trim());
                setReply("");
              }}
            >
              <Label htmlFor="question-answer">回答這個問題</Label>
              <Textarea
                id="question-answer"
                rows={2}
                maxLength={2000}
                value={reply}
                placeholder="點上方的常見答案，或直接輸入"
                onChange={(e) => setReply(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                系統會把回答併進需求。查詢會直接繼續；修改需求會再請管理者確認。群組成員也可以在
                LINE「回覆」機器人的提問來回答。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !reply.trim()}
                >
                  送出回答
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={amend}
                >
                  改成編輯整份需求
                </Button>
              </div>
            </form>
          )}
        </section>
      )}
      {assumptions.length > 0 && (
        <section
          aria-label="我先這樣假設"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <h3 className="text-sm font-medium">我先這樣假設</h3>
          <p className="text-xs text-muted-foreground">
            {createsFollowup
              ? "修改假設會建立一題追問，保留目前的回答。"
              : "可以直接修改其中一項；儲存後會更新需求，請重新確認。"}
          </p>
          <ul className="flex flex-col gap-3">
            {assumptions.map((assumption, index) => (
              <li key={index} className="flex flex-col gap-2">
                {draft?.index === index ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!stale && editable)
                        void act(
                          task,
                          "assumption",
                          { index, value: draft.value.trim() },
                          createsFollowup
                            ? "已依新假設建立追問，原回答保留"
                            : "假設已更新，請重新確認需求",
                        );
                    }}
                  >
                    <Label htmlFor={`assumption-${index}`}>
                      修改第 {index + 1} 項假設
                    </Label>
                    <Textarea
                      id={`assumption-${index}`}
                      autoFocus
                      maxLength={500}
                      value={draft.value}
                      onChange={(event) =>
                        setEditing({ ...draft, value: event.target.value })
                      }
                    />
                    {stale && (
                      <p role="status" className="text-xs text-warn">
                        需求已更新，請取消編輯並查看最新假設後再修改。
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={
                          busy ||
                          !editable ||
                          stale ||
                          !draft.value.trim() ||
                          draft.value.trim() === assumption
                        }
                      >
                        {createsFollowup ? "依新假設接著問" : "儲存假設"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm whitespace-pre-wrap">
                      {assumption}
                    </span>
                    {editable && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !!draft}
                        aria-label={`修改第 ${index + 1} 項假設`}
                        onClick={() =>
                          setEditing({
                            index,
                            value: assumption,
                            version: task.version,
                          })
                        }
                      >
                        修改
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
