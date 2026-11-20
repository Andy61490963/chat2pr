import type { Memory } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardContent,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { type State, ago } from "./shared";
const memorySource: Record<Memory["source"], string> = {
  ai: "AI 自動記住",
  chat: "群組要求",
  admin: "管理者",
};
const knowledgeStatus = {
  pending: "準備寫入",
  in_pr: "PR 待合併",
  merged: "已寫入 AGENTS.md",
  closed: "已關閉",
} as const;

export function MemoryOverview({
  state,
  go,
}: {
  state: State;
  go: (v: "groups" | "projects") => void;
}) {
  const bySource = (s: Memory["source"]) =>
    state.memories.filter((m) => m.source === s).length;
  const recent = [...state.memories]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  return (
    <Card>
      <CardHeader>
        <CardTitle>記憶總覽</CardTitle>
        <CardDescription>
          群組記憶讓 AI 判斷要改哪個專案；專案記憶會以 PR 寫進該專案的
          AGENTS.md，Codex 每次開發都會遵守。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          {[
            ["群組記憶", state.memories.length],
            ["AI 自動記住", bySource("ai")],
            ["群組要求／管理者", bySource("chat") + bySource("admin")],
            ["專案記憶", state.knowledge.length],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="text-xl font-semibold tabular-nums">
                {value}
              </span>
            </div>
          ))}
        </div>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">
              最近新增的群組記憶
            </h3>
            <Button variant="link" size="sm" onClick={() => go("groups")}>
              選擇要編輯的群組
            </Button>
          </div>
          {recent.length ? (
            <ul className="divide-y rounded-lg border">
              {recent.map((m) => (
                <li key={m.id} className="flex flex-col gap-0.5 px-3 py-2.5">
                  <span className="text-sm [overflow-wrap:anywhere]">
                    {m.content}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {state.groups.find((g) => g.id === m.group_id)?.name ??
                      "群組"}
                    {" · "}
                    {state.projects.find((p) => p.id === m.project_id)?.name ??
                      "不指定專案"}
                    {" · "}
                    <span
                      className={m.source === "ai" ? "text-info" : undefined}
                    >
                      {memorySource[m.source] ?? "群組要求"}
                    </span>
                    {" · "}
                    {ago(m.created_at)}
                    {m.project_id &&
                      !state.groups
                        .find((g) => g.id === m.group_id)
                        ?.project_ids.includes(m.project_id) && (
                        <span className="text-warn">
                          {" · "}專案已不在此群組，暫不使用
                        </span>
                      )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有群組記憶。</p>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">
              專案記憶
            </h3>
            <Button variant="link" size="sm" onClick={() => go("projects")}>
              到專案管理
            </Button>
          </div>
          {state.knowledge.length ? (
            <ul className="divide-y rounded-lg border">
              {state.knowledge.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="[overflow-wrap:anywhere]">
                      {k.content}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {state.projects.find((p) => p.id === k.project_id)
                        ?.name ?? "專案"}{" "}
                      · {ago(k.created_at)}
                    </span>
                  </span>
                  <Badge variant={k.status === "merged" ? "good" : "secondary"}>
                    {knowledgeStatus[k.status]}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有專案記憶。</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
