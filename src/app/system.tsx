import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type { Memory } from "../../shared/types.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type Request, type State, ago, date, message } from "./shared";

type ContainerStatus = {
  name: string;
  role: string;
  image: string;
  state: string;
  status: string;
  created: string;
  runId?: string;
};
type SystemStatus = {
  checkedAt: string;
  requiredWorkerRev: string;
  services: ContainerStatus[];
  jobs: ContainerStatus[];
  images: {
    tag: string;
    rev: string | null;
    current: boolean;
    sizeMb: number;
    created: string;
  }[];
  volumes: { jobs: number; sourceCaches: number };
};

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

export function SystemView({
  state,
  request,
  go,
}: {
  state: State;
  request: Request;
  go: (v: "groups" | "projects") => void;
}) {
  const [status, setStatus] = useState<SystemStatus | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await request<SystemStatus>("/api/system"));
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>容器狀態</CardTitle>
            <CardDescription>
              {status
                ? `每 30 秒更新，最後更新 ${ago(status.checkedAt)}`
                : "讀取中…"}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={cn(loading && "animate-spin")} /> 重新整理
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}（執行器可能未啟動）
            </p>
          )}
          {status && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  服務
                </h3>
                <ul className="divide-y rounded-lg border">
                  <ServiceRow
                    name="執行器 runner"
                    role="主機上的程序（4312），負責建立與回收工作容器"
                    ok={!error}
                    detail={error ? "無法連線" : "連線正常"}
                  />
                  {status.services.map((c) => (
                    <ServiceRow
                      key={c.name}
                      name={c.name.replace(/^line-agentflow-|-1$/g, "")}
                      role={c.role}
                      ok={c.state === "running"}
                      detail={c.status}
                    />
                  ))}
                </ul>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  執行中的工作容器
                </h3>
                {status.jobs.length ? (
                  <ul className="divide-y rounded-lg border">
                    {status.jobs.map((c) => (
                      <ServiceRow
                        key={c.name}
                        name={c.name}
                        role={`執行 ${c.runId?.slice(0, 8) ?? ""} · ${c.image}`}
                        ok={c.state === "running"}
                        detail={c.status}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    目前沒有工作容器在執行。
                  </p>
                )}
              </section>
              <section className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    工作映像（需要版本 {status.requiredWorkerRev} 以後）
                  </h3>
                  <ul className="divide-y rounded-lg border">
                    {status.images.map((i) => {
                      const used = state.projects
                        .filter((p) => p.image === i.tag)
                        .map((p) => p.name);
                      return (
                        <li
                          key={i.tag}
                          className="flex items-center gap-3 px-3 py-2.5 text-sm"
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <code className="truncate text-xs">{i.tag}</code>
                            <span className="truncate text-xs text-muted-foreground">
                              {used.length
                                ? `使用中：${used.join("、")}`
                                : "沒有專案使用"}{" "}
                              · {(i.sizeMb / 1024).toFixed(1)} GB · 建立於{" "}
                              {date(i.created)}
                            </span>
                          </span>
                          <Badge variant={i.current ? "good" : "warn"}>
                            {i.current ? `版本 ${i.rev}` : "過舊，需重建"}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    磁碟上的工作資料
                  </h3>
                  <dl className="grid grid-cols-[1fr_auto] gap-y-2 rounded-lg border px-3 py-2.5 text-sm">
                    <dt className="text-muted-foreground">任務工作區</dt>
                    <dd className="tabular-nums">{status.volumes.jobs} 個</dd>
                    <dt className="text-muted-foreground">原始碼快取</dt>
                    <dd className="tabular-nums">
                      {status.volumes.sourceCaches} 個
                    </dd>
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    任務工作區保留 30 天後由每小時的維護工作清除。
                  </p>
                </div>
              </section>
            </>
          )}
        </CardContent>
      </Card>
      <MemoryOverview state={state} go={go} />
      <Architecture state={state} />
    </div>
  );
}

function ServiceRow({
  name,
  role,
  ok,
  detail,
}: {
  name: string;
  role: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          ok ? "bg-good" : "bg-danger",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{role}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-xs",
          ok ? "text-muted-foreground" : "text-danger",
        )}
      >
        {detail}
      </span>
    </li>
  );
}

function MemoryOverview({
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
              到群組管理
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

/* ---------- 系統架構圖 ---------- */

const ActiveBoxes = createContext<string[]>([]);
type BoxProps = {
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines?: string[];
  tone?: "default" | "brand" | "muted" | "warn";
};
function Box({
  id,
  x,
  y,
  w,
  h,
  title,
  lines = [],
  tone = "default",
}: BoxProps) {
  const activeIds = useContext(ActiveBoxes);
  const active = !!id && activeIds.includes(id);
  const stroke = active
    ? "var(--brand)"
    : tone === "brand"
      ? "var(--brand)"
      : tone === "warn"
        ? "var(--warn)"
        : "var(--border)";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={
          active
            ? "var(--brand-soft)"
            : tone === "muted"
              ? "var(--muted)"
              : "var(--card)"
        }
        stroke={stroke}
        strokeWidth={active ? 2.6 : tone === "brand" ? 1.6 : 1.2}
        style={{ transition: "fill .3s, stroke .3s, stroke-width .3s" }}
      />
      <text
        x={x + 12}
        y={y + 22}
        fontSize={13}
        fontWeight={600}
        fill="var(--foreground)"
      >
        {title}
      </text>
      {lines.map((l, i) => (
        <text
          key={i}
          x={x + 12}
          y={y + 42 + i * 17}
          fontSize={11.5}
          fill="var(--muted-foreground)"
        >
          {l}
        </text>
      ))}
    </g>
  );
}
function Arrow({
  d,
  label,
  lx,
  ly,
  dashed,
}: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  dashed?: boolean;
}) {
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.2}
        strokeDasharray={dashed ? "4 4" : undefined}
        markerEnd="url(#arrow)"
      />
      {label && (
        <text
          x={lx}
          y={ly}
          fontSize={10.5}
          fill="var(--muted-foreground)"
          textAnchor="middle"
        >
          {label}
        </text>
      )}
    </g>
  );
}

/* ---------- 流程動畫 ---------- */

// 每一步：亮起哪些方框、小點沿哪條線移動，以及這一步的說明。
type FlowStep = {
  title: string;
  detail: string;
  active: string[];
  path?: string;
};
const flowSteps = (open: boolean): FlowStep[] => [
  {
    title: "收到訊息",
    detail:
      "成員在 LINE 群組傳訊息，LINE 把它以 Webhook 送到 ngrok 固定 HTTPS 入口。",
    active: ["line", "ngrok"],
    path: "M210 66 L250 66",
  },
  {
    title: "驗證並存檔",
    detail:
      "app 驗證 LINE 簽章，把訊息存進資料庫；有圖片時在背景下載。這時還不會馬上判讀，先等群組安靜下來。",
    active: ["ngrok", "app", "db"],
    path: "M370 98 L370 128 M490 176 L530 176",
  },
  {
    title: "準備判讀資料",
    detail:
      "群組安靜 60 秒（或累積 5 分鐘）後，app 整理這段時間的碎片訊息，並用本機向量模型檢索舊對話、群組記憶與過去任務。",
    active: ["app", "db", "embedder"],
    path: "M490 282 L530 282",
  },
  {
    title: "AI 判讀需求",
    detail:
      "app 請執行器開一個一次性的判讀容器；容器經訂閱轉送與 egress-ai 呼叫 ChatGPT，判斷是不是需求、要改哪個專案、有沒有風險，必要時順便記住新規則。",
    active: ["app", "runner", "relay", "egressAi", "chatgpt"],
    path: "M470 128 L470 114 L760 114 L760 74 L790 74 M790 460 L490 460 M370 500 L370 530 M250 580 L210 580",
  },
  {
    title: "決定要不要等你",
    detail:
      "修改一律先確認，明確且符合規則的查詢可自動排程；只缺資訊時問一件事，有合理預設就列出假設，產品方向不同時才提供推薦選項。",
    active: ["app", "admin"],
    path: "M250 190 L210 190",
  },
  {
    title: "派工給執行器",
    detail:
      "排程輪到這張任務時，app 以執行器金鑰呼叫主機上的執行器，由它建立工作容器（非 root、唯讀根目錄、限制 CPU 與記憶體）。",
    active: ["app", "runner", "jobs"],
    path: "M470 128 L470 114 L760 114 L760 74 L790 74 M935 114 L935 140",
  },
  {
    title: "0 準備原始碼",
    detail:
      "執行器用短期 GitHub 權杖抓取專案原始碼，相同版本直接使用本機快取。",
    active: ["jobs", "s0", "github"],
    path: "M790 410 L115 410 L115 430",
  },
  {
    title: "1 安裝相依套件",
    detail:
      "執行專案的安裝命令，只能經 egress 白名單下載 npm、PyPI、NuGet 套件。",
    active: ["jobs", "s1", "egress", "packages"],
    path: "M790 570 L750 570 M640 610 L640 672 L210 672",
  },
  {
    title: "2 Codex 修改程式",
    detail: open
      ? "Codex 依需求修改程式；推論經訂閱轉送到 ChatGPT。目前已完全開放網路，也能直接連網際網路與公司內網（例如資料庫）。"
      : "Codex 依需求修改程式；推論經訂閱轉送到 ChatGPT，缺套件時可經白名單下載。",
    active: open
      ? ["jobs", "s2", "relay", "egressAi", "chatgpt", "intranet"]
      : ["jobs", "s2", "relay", "egressAi", "chatgpt"],
    path: "M790 460 L490 460 M370 500 L370 530 M250 580 L210 580",
  },
  {
    title: "3 收集差異、4 跑測試",
    detail: open
      ? "以可信基底計算這次的變更，再執行專案的測試命令；完全開放時測試也能連公司內網。"
      : "以可信基底計算這次的變更，再在沒有網路的容器裡執行專案的測試命令。",
    active: ["jobs", "s3", "s4"],
    path: "M935 422 L935 488",
  },
  {
    title: "5 獨立審查",
    detail:
      "另一個 Codex 在唯讀工作區檢查變更是否符合需求、測試是否可信；不通過會自動修復一次，仍失敗就停下交給你。",
    active: ["jobs", "s5", "relay", "egressAi", "chatgpt"],
    path: "M790 460 L490 460 M370 500 L370 530 M250 580 L210 580",
  },
  {
    title: "開 PR 並通知你",
    detail:
      "通過後 app 以 GitHub App 建立分支、Issue 與 PR，並私訊你；由你在 GitHub 審閱與合併，合併事件會回寫看板成為之後的經驗。若是查詢任務，Codex 調查完就直接把報告存到任務上、回覆到 Issue 並私訊你，不做收集、測試與 PR。",
    active: ["app", "github", "admin"],
    path: "M250 300 L230 300 L230 480 L210 480 M250 190 L210 190",
  },
];

function FlowDot({ path, step }: { path?: string; step: number }) {
  const ref = useRef<SVGAnimateMotionElement>(null);
  useEffect(() => {
    // 動態加入的 SMIL 動畫要手動開始，否則會直接跳到結尾。
    ref.current?.beginElement();
  }, [step]);
  if (!path) return null;
  return (
    <circle r={7} fill="var(--brand)" stroke="var(--card)" strokeWidth={2}>
      <animateMotion
        ref={ref}
        begin="indefinite"
        dur={`${Math.min(2.4, 0.6 + path.split(" ").length * 0.06)}s`}
        fill="freeze"
        path={path}
      />
    </circle>
  );
}

function Architecture({ state }: { state: State }) {
  const open = state.settings.container_network === "open";
  const downloads = state.settings.code_downloads !== false;
  const steps = flowSteps(open);
  const [step, setStep] = useState(-1),
    [playing, setPlaying] = useState(false);
  const current = step >= 0 ? steps[step] : undefined;
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(
      () => {
        if (step >= steps.length - 1) setPlaying(false);
        else setStep(step + 1);
      },
      step < 0 ? 0 : 3200,
    );
    return () => clearTimeout(t);
  }, [playing, step, steps.length]);
  const go = (n: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(steps.length - 1, n)));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>系統架構</CardTitle>
        <CardDescription>
          從 LINE 訊息到 GitHub PR
          的完整路徑、每個元件的位置與網路權限。灰色虛線是通知與回寫。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (step >= steps.length - 1) setStep(-1);
                  setPlaying(true);
                }
              }}
            >
              {playing ? <Pause /> : <Play />}
              {playing
                ? "暫停"
                : step < 0
                  ? "播放：一則訊息怎麼變成 PR"
                  : "繼續播放"}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一步"
              disabled={step <= 0}
              onClick={() => go(step - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一步"
              disabled={step >= steps.length - 1}
              onClick={() => go(step + 1)}
            >
              <ChevronRight />
            </Button>
            <ol className="ml-auto flex gap-1" aria-label="流程步驟">
              {steps.map((st, i) => (
                <li key={st.title}>
                  <button
                    aria-label={`第 ${i + 1} 步：${st.title}`}
                    aria-current={i === step ? "step" : undefined}
                    onClick={() => go(i)}
                    className={cn(
                      "block h-1.5 w-5 rounded-full bg-border transition-colors",
                      i < step && "bg-brand/40",
                      i === step && "bg-brand",
                    )}
                  />
                </li>
              ))}
            </ol>
          </div>
          <div aria-live="polite" className="min-h-12">
            {current ? (
              <>
                <p className="text-sm font-medium">
                  <span className="mr-2 text-muted-foreground tabular-nums">
                    {step + 1}/{steps.length}
                  </span>
                  {current.title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {current.detail}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                按播放後，綠點會沿著線移動，正在運作的元件會亮起，並在這裡說明每一步在做什麼。也可以點右側的格子跳到任一步。
              </p>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-background p-2">
          <svg
            viewBox="0 0 1100 720"
            className="min-w-[860px]"
            role="img"
            aria-label="LINE AgentFlow 系統架構圖"
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
              </marker>
            </defs>
            <ActiveBoxes.Provider value={current?.active ?? []}>
              {/* 欄位標題 */}
              {[
                [20, "外部服務"],
                [250, "入口與核心服務（Docker Compose）"],
                [530, "資料與 AI 出口"],
                [790, "執行（主機上的執行器＋工作容器）"],
              ].map(([x, t]) => (
                <text
                  key={t as string}
                  x={x as number}
                  y={18}
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--muted-foreground)"
                >
                  {t}
                </text>
              ))}

              {/* 外部 */}
              <Box
                x={20}
                y={34}
                w={190}
                h={64}
                id="line"
                title="LINE 群組"
                lines={["成員在群組提需求、補充、貼圖"]}
              />
              <Box
                x={20}
                y={128}
                w={190}
                h={80}
                id="admin"
                title="管理者"
                lines={["瀏覽器看板（GitHub 登入）", "LINE 私訊通知與快速核准"]}
              />
              <Box
                x={20}
                y={430}
                w={190}
                h={80}
                id="github"
                title="GitHub"
                lines={["GitHub App 權杖", "原始碼、Issue、PR、合併事件"]}
              />
              <Box
                x={20}
                y={548}
                w={190}
                h={64}
                id="chatgpt"
                title="ChatGPT 訂閱"
                lines={["Codex 推論（計入方案額度）"]}
              />
              <Box
                x={20}
                y={640}
                w={190}
                h={64}
                id="packages"
                title="套件來源"
                lines={["npmjs、PyPI、NuGet"]}
                tone="muted"
              />

              {/* 入口與核心 */}
              <Box
                x={250}
                y={34}
                w={240}
                h={64}
                id="ngrok"
                title="ngrok 固定 HTTPS 入口"
                lines={["Webhook 與看板的唯一對外入口"]}
              />
              <Box
                x={250}
                y={128}
                w={240}
                h={262}
                id="app"
                title="app 容器（Fastify，:4310）"
                lines={[
                  "① Webhook 驗簽收訊、存訊息與圖片",
                  "② 需求判讀：彙整碎片訊息、",
                  "    RAG 檢索、風險規則、必要問題與假設",
                  "③ pg-boss 排程：派工、驗證、",
                  "    索引、通知、清理、備份",
                  "④ 看板 API＋即時更新（SSE）",
                  "⑤ 群組／成員名稱同步 LINE",
                  "⑥ 推論代理：發給工作容器",
                  "    有期限的推論授權",
                  "⑦ LINE 推播通知管理者",
                ]}
              />
              <Box
                x={250}
                y={420}
                w={240}
                h={80}
                id="relay"
                title="subscription-relay"
                lines={["訂閱推論轉送（:4313 代理）", "容器內沒有登入檔"]}
              />
              <Box
                x={250}
                y={530}
                w={240}
                h={64}
                id="egressAi"
                title="egress-ai（squid）"
                lines={["只允許 chatgpt.com、openai.com"]}
              />

              {/* 資料 */}
              <Box
                x={530}
                y={128}
                w={220}
                h={96}
                id="db"
                title="PostgreSQL＋pgvector"
                lines={[
                  "訊息、任務、記憶、設定",
                  "向量索引、稽核紀錄",
                  "volume：line-agentflow_database",
                ]}
              />
              <Box
                x={530}
                y={250}
                w={220}
                h={64}
                id="embedder"
                title="embedder（bge-m3）"
                lines={["本機向量模型，不連外"]}
              />
              <Box
                x={530}
                y={328}
                w={220}
                h={64}
                id="backup"
                title="每日加密備份"
                lines={["/data/backups，保留 7 份"]}
              />
              <Box
                x={530}
                y={530}
                w={220}
                h={80}
                id="egress"
                title="egress（squid）"
                lines={["安裝階段套件出口", "npm、PyPI、NuGet 白名單"]}
              />

              {/* 執行 */}
              <Box
                x={790}
                y={34}
                w={290}
                h={80}
                id="runner"
                title="執行器 runner（主機程序，:4312）"
                lines={["唯一能操作 Docker 的元件", "建立、限制、回收工作容器"]}
              />
              <rect
                x={790}
                y={140}
                width={290}
                height={470}
                rx={10}
                fill="var(--muted)"
                stroke={
                  current?.active.includes("jobs")
                    ? "var(--brand)"
                    : "var(--border)"
                }
                strokeWidth={current?.active.includes("jobs") ? 2.2 : 1}
                style={{ transition: "stroke .3s" }}
              />
              <text
                x={802}
                y={162}
                fontSize={13}
                fontWeight={600}
                fill="var(--foreground)"
              >
                工作容器（每階段一個，用完即刪）
              </text>
              <text
                x={802}
                y={180}
                fontSize={11}
                fill="var(--muted-foreground)"
              >
                非 root、唯讀根目錄、2 CPU、2 GB、無 Docker socket
              </text>
              {[
                ["0 準備原始碼", "以短期 GitHub 權杖抓取，快取於 volume"],
                ["1 安裝 install", "安裝命令；經 egress 白名單下載套件"],
                [
                  "2 開發 code",
                  open
                    ? "Codex 修改；完全開放網路"
                    : downloads
                      ? "Codex 修改；可經白名單下載套件"
                      : "Codex 修改；只連推論轉送",
                ],
                ["3 收集 collect", "以可信基底計算差異（上限 10 MB）"],
                [
                  "4 測試 test",
                  open ? "專案測試命令；完全開放網路" : "專案測試命令；無網路",
                ],
                [
                  "5 審查 review",
                  open
                    ? "獨立審查；工作區唯讀，可連外"
                    : "獨立審查；工作區唯讀",
                ],
              ].map(([t, d], i) => (
                <Box
                  key={t}
                  id={`s${i}`}
                  x={806}
                  y={196 + i * 66}
                  w={258}
                  h={56}
                  title={t}
                  lines={[d]}
                />
              ))}
              <Box
                x={790}
                y={640}
                w={290}
                h={64}
                id="intranet"
                title="網際網路與公司內網"
                lines={[
                  open
                    ? "已開放：可連資料庫等內部系統"
                    : "目前未開放（設定頁可切換）",
                ]}
                tone={open ? "warn" : "muted"}
              />

              {/* 流向 */}
              <Arrow d="M210 66 L250 66" label="Webhook" lx={230} ly={58} />
              <Arrow
                d="M210 160 L240 160 L240 90 L250 90"
                label="看板"
                lx={226}
                ly={152}
              />
              <Arrow d="M370 98 L370 128" />
              <Arrow d="M490 176 L530 176" label="SQL" lx={510} ly={168} />
              <Arrow d="M490 282 L530 282" label="向量" lx={510} ly={274} />
              <Arrow d="M490 360 L530 360" label="備份" lx={510} ly={352} />
              <Arrow
                d="M470 128 L470 114 L760 114 L760 74 L790 74"
                label="HTTP（執行器金鑰）"
                lx={640}
                ly={108}
              />
              <Arrow d="M935 114 L935 140" />
              <Arrow
                d="M250 190 L210 190"
                label="推播"
                lx={230}
                ly={184}
                dashed
              />
              <Arrow
                d="M250 300 L230 300 L230 480 L210 480"
                label="PR"
                lx={230}
                ly={292}
              />
              <Arrow
                d="M790 410 L115 410 L115 430"
                label="0 抓取原始碼"
                lx={640}
                ly={404}
                dashed
              />
              <Arrow d="M790 570 L750 570" label="1 套件" lx={770} ly={562} />
              <Arrow
                d="M790 460 L490 460"
                label="2／5 推論"
                lx={640}
                ly={452}
              />
              <Arrow d="M370 500 L370 530" />
              <Arrow d="M250 580 L210 580" label="HTTPS" lx={230} ly={572} />
              <Arrow
                d="M640 610 L640 672 L210 672"
                label="白名單"
                lx={420}
                ly={666}
              />
              <Arrow
                d="M935 610 L935 640"
                label={open ? "完全開放" : "未開放"}
                lx={975}
                ly={630}
                dashed={!open}
              />
            </ActiveBoxes.Provider>
            <FlowDot key={step} path={current?.path} step={step} />
          </svg>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">一則需求的完整流程</h3>
          <ol className="flex flex-col gap-2 text-sm">
            {[
              [
                "收訊",
                "LINE 經 ngrok 送 Webhook 到 app，驗證簽章後存入資料庫；圖片在背景下載，原文保留 30 天。",
              ],
              [
                "判讀",
                "群組安靜 60 秒（或累積 5 分鐘）後，app 在一次性 AI 容器裡彙整碎片訊息，參考近期對話、群組記憶與 RAG 檢索，判斷是否為需求、要改哪個專案，並套用固定風險規則；也可能自動記住新規則。",
              ],
              [
                "審核",
                "修改一律先確認，符合規則的查詢可自動排程；缺必要資訊時只問一件事，合理預設列入假設，產品方向不同才提供推薦選項，需確認的任務進收件匣並通知管理者。",
              ],
              [
                "開發",
                "執行器依序建立工作容器：抓原始碼 → 安裝相依 → Codex 修改 → 收集差異 → 跑測試 → 獨立審查。失敗會自動修復一次，仍失敗就停下來交給你。",
              ],
              [
                "發布",
                "通過後 app 以 GitHub App 建立分支、Issue 與 PR，私訊通知管理者；由你在 GitHub 審閱與合併，合併事件回寫看板並成為之後的經驗。",
              ],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="w-5 shrink-0 text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                <span>
                  <span className="font-medium">{t}</span>
                  <span className="text-muted-foreground">：{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">工作容器各階段的權限</h3>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">階段</th>
                  <th className="px-3 py-2 font-medium">做什麼</th>
                  <th className="px-3 py-2 font-medium">網路</th>
                  <th className="px-3 py-2 font-medium">工作區</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[
                  [
                    "安裝",
                    "執行專案的安裝命令",
                    "套件白名單（npm、PyPI、NuGet）",
                    "可寫",
                  ],
                  [
                    "開發",
                    "Codex 依需求修改程式",
                    open
                      ? "完全開放（網際網路、公司內網）＋推論轉送"
                      : downloads
                        ? "推論轉送＋套件白名單"
                        : "只有推論轉送",
                    "可寫",
                  ],
                  ["收集", "以可信基底計算變更", "無", "可寫"],
                  [
                    "測試",
                    "執行專案的測試命令",
                    open ? "完全開放" : "無",
                    "可寫",
                  ],
                  [
                    "審查",
                    "另一個 Codex 獨立檢查",
                    open ? "完全開放＋推論轉送" : "只有推論轉送",
                    "唯讀",
                  ],
                ].map((r) => (
                  <tr key={r[0]}>
                    {r.map((c, i) => (
                      <td
                        key={i}
                        className={cn(
                          "px-3 py-2",
                          i === 0 && "font-medium",
                          i === 2 && c.startsWith("完全開放") && "text-warn",
                        )}
                      >
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">資料存放位置</h3>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <tbody className="divide-y">
                {[
                  ["資料庫", "Docker volume line-agentflow_database"],
                  [
                    "每日備份",
                    "\\\\wsl.localhost\\docker-desktop\\mnt\\docker-desktop-disk\\data\\docker\\volumes\\line-agentflow_data\\_data\\backups",
                  ],
                  [
                    "備份解密金鑰",
                    "專案目錄 .local/secrets.json 的 sessionSecret（遺失就無法還原）",
                  ],
                  ["服務的 Codex 登入", "專案目錄 .codex-service/"],
                  ["向量模型", "Docker volume line-agentflow_embed-models"],
                  [
                    "任務工作區",
                    "Docker volume agentflow-job-*（30 天後清除）",
                  ],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="w-36 px-3 py-2 font-medium">{k}</td>
                    <td className="px-3 py-2 font-mono text-xs break-all text-muted-foreground">
                      {v}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
