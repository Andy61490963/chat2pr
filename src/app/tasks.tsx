import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { Task } from "../../shared/types.js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskRow } from "./inbox";
import {
  type State,
  attention,
  Empty,
  LoadMore,
  moving,
  SectionTitle,
  writeQuery,
} from "./shared";

const filters = [
  { id: "all", label: "全部", match: () => true },
  {
    id: "todo",
    label: "待處理",
    match: (t: Task) => attention.includes(t.status),
  },
  {
    id: "moving",
    label: "進行中",
    match: (t: Task) => moving.includes(t.status),
  },
  { id: "ready", label: "待合併", match: (t: Task) => t.status === "ready" },
  {
    id: "closed",
    label: "已結束",
    match: (t: Task) =>
      ["merged", "answered", "closed", "rejected", "cancelled"].includes(t.status),
  },
] as const;
type By = "project" | "group" | "none";

export function TasksView({
  state,
  open,
  more,
}: {
  state: State;
  open: (id: string) => unknown;
  more: () => unknown;
}) {
  // 篩選條件放在網址，重新整理、上一頁或把連結傳給別人都會看到同一份清單。
  const read = () => {
    const q = new URLSearchParams(location.search);
    const pick = (key: string, ok: (v: string) => boolean, fallback: string) => {
      const v = q.get(key);
      return v && ok(v) ? v : fallback;
    };
    return {
      filter: pick("filter", (v) => filters.some((f) => f.id === v), "all"),
      group: pick("group", (v) => state.groups.some((g) => g.id === v), "all"),
      project: pick(
        "project",
        (v) => v === "none" || state.projects.some((p) => p.id === v),
        "all",
      ),
      by: pick("by", (v) => ["project", "group", "none"].includes(v), "project") as By,
      search: q.get("q") ?? "",
    };
  };
  const [initial] = useState(read);
  const [filter, setFilter] = useState<string>(initial.filter),
    [group, setGroup] = useState(initial.group),
    [project, setProject] = useState(initial.project),
    [by, setBy] = useState<By>(initial.by),
    [search, setSearch] = useState(initial.search);
  useEffect(() => {
    writeQuery([
      ["filter", filter, "all"],
      ["group", group, "all"],
      ["project", project, "all"],
      ["by", by, "project"],
      ["q", search, ""],
    ]);
  }, [filter, group, project, by, search]);
  // 上一頁／下一頁換到另一組篩選時，畫面跟著網址走。
  useEffect(() => {
    const onPop = () => {
      const v = read();
      setFilter(v.filter);
      setGroup(v.group);
      setProject(v.project);
      setBy(v.by);
      setSearch(v.search);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });
  const narrowed =
    filter !== "all" || group !== "all" || project !== "all" || search !== "";
  const clear = () => {
    setFilter("all");
    setGroup("all");
    setProject("all");
    setSearch("");
  };
  const match = filters.find((f) => f.id === filter)!.match;
  const list = state.tasks.filter(
    (t) =>
      match(t) &&
      (group === "all" || t.group_id === group) &&
      (project === "all" || (t.project_id ?? "none") === project) &&
      `${t.title}${t.summary}`.toLowerCase().includes(search.toLowerCase()),
  );
  // 依專案或群組分段，任務多時一眼看出各自的進度。
  const keyOf = (t: Task) =>
    by === "project" ? (t.project_id ?? "none") : t.group_id;
  const sections =
    by === "none"
      ? [{ key: "all", name: "", tasks: list }]
      : [...new Set(list.map(keyOf))].map((key) => ({
          key,
          name:
            by === "project"
              ? (state.projects.find((p) => p.id === key)?.name ?? "未指定專案")
              : (state.groups.find((g) => g.id === key)?.name ?? "群組"),
          tasks: list.filter((t) => keyOf(t) === key),
        }));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            {filters.map((f) => (
              <TabsTrigger key={f.id} value={f.id}>
                {f.label}
                <span className="text-xs text-muted-foreground">
                  {state.tasks.filter(f.match).length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap gap-2">
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger className="w-40" aria-label="群組">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有群組</SelectItem>
              {state.groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="w-44" aria-label="專案">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有專案</SelectItem>
              {state.projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              <SelectItem value="none">未指定專案</SelectItem>
            </SelectContent>
          </Select>
          <Select value={by} onValueChange={(v) => setBy(v as By)}>
            <SelectTrigger className="w-36" aria-label="分組方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">依專案分組</SelectItem>
              <SelectItem value="group">依群組分組</SelectItem>
              <SelectItem value="none">不分組</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜尋任務"
              aria-label="搜尋任務"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>
      {list.length ? (
        sections.map((s) => (
          <section key={s.key}>
            {s.name && (
              <SectionTitle count={s.tasks.length}>{s.name}</SectionTitle>
            )}
            <Card className="gap-0 py-1">
              {s.tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  state={state}
                  open={open}
                  hide={by}
                />
              ))}
            </Card>
          </section>
        ))
      ) : (
        <Card>
          {narrowed ? (
            <Empty title="沒有符合條件的任務">
              <span className="flex flex-col items-center gap-3">
                換個篩選或搜尋字詞試試；目前共有 {state.tasks.length} 個任務。
                <Button variant="outline" size="sm" onClick={clear}>
                  清除篩選
                </Button>
              </span>
            </Empty>
          ) : (
            <Empty title="還沒有任務">
              群組裡的需求整理好後會出現在這裡。
            </Empty>
          )}
        </Card>
      )}
      {/* 伺服器只先給最近的任務；更早的要按了才載入，篩選與搜尋也只看得到已載入的。 */}
      <LoadMore
        shown={state.tasks.length}
        total={state.totals?.tasks}
        unit="個任務"
        more={more}
      />
    </div>
  );
}
