import { DataList, ListRow, SectionHeader } from "@/components/ui/layout";
import type { Memory } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    <section aria-labelledby="memory-overview-title" className="space-y-4 border-t pt-4">
      <header className="space-y-1">
        <SectionHeader id="memory-overview-title">記憶總覽</SectionHeader>
        <p className="text-sm text-muted-foreground">
          群組記憶讓 AI 判斷要改哪個專案；專案記憶會以 PR 寫進該專案的
          AGENTS.md，Codex 每次開發都會遵守。
        </p>
      </header>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-4">
          {[
            ["群組記憶", state.memories.length],
            ["AI 自動記住", bySource("ai")],
            ["群組要求／管理者", bySource("chat") + bySource("admin")],
            ["專案記憶", state.knowledge.length],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 bg-background px-3 py-2">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="text-xl font-semibold tabular-nums">
                {value}
              </span>
            </div>
          ))}
        </div>
        <section aria-labelledby="recent-group-memory-title" className="flex flex-col gap-2">
          <SectionHeader
            as="h3"
            id="recent-group-memory-title"
            action={
              <Button variant="link" size="sm" className="min-h-11" onClick={() => go("groups")}>
                選擇要編輯的群組
              </Button>
            }
          >
            最近新增的群組記憶
          </SectionHeader>
          {recent.length ? (
            <DataList className="border-y">
              {recent.map((m) => (
                <ListRow key={m.id} className="flex flex-col gap-0.5">
                  <span className="text-sm wrap-anywhere">
                    {m.content}
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground wrap-anywhere">
                    <span>
                      {state.groups.find((g) => g.id === m.group_id)?.name ??
                        "群組"}
                    </span>
                    <span>
                      {state.projects.find((p) => p.id === m.project_id)?.name ??
                        "不指定專案"}
                    </span>
                    <span
                      className={m.source === "ai" ? "text-info" : undefined}
                    >
                      {memorySource[m.source] ?? "群組要求"}
                    </span>
                    <time dateTime={m.created_at}>{ago(m.created_at)}</time>
                    {m.project_id &&
                      !state.groups
                        .find((g) => g.id === m.group_id)
                        ?.project_ids.includes(m.project_id) && (
                        <span className="text-warn">
                          專案已不在此群組，暫不使用
                        </span>
                      )}
                  </div>
                </ListRow>
              ))}
            </DataList>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有群組記憶。</p>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <SectionHeader
            as="h3"
            action={
              <Button variant="link" size="sm" onClick={() => go("projects")}>
                到專案管理
              </Button>
            }
          >
            專案記憶
          </SectionHeader>
          {state.knowledge.length ? (
            <DataList className="border-y">
              {state.knowledge.map((k) => (
                <ListRow
                  key={k.id}
                  className="flex items-center gap-3 text-sm"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="wrap-anywhere">
                      {k.content}
                    </span>
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground wrap-anywhere">
                      <span>
                        {state.projects.find((p) => p.id === k.project_id)
                          ?.name ?? "專案"}
                      </span>
                      <time dateTime={k.created_at}>{ago(k.created_at)}</time>
                    </span>
                  </span>
                  <Badge variant={k.status === "merged" ? "good" : "secondary"}>
                    {knowledgeStatus[k.status]}
                  </Badge>
                </ListRow>
              ))}
            </DataList>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有專案記憶。</p>
          )}
        </section>
      </div>
    </section>
  );
}
