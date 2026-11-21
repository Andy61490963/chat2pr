import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";
import {
  type Request,
  type State,
  ago,
  date,
  memoryHold,
  message,
} from "./shared";
import { CapacityCard } from "./capacity";
import { DockerDiskCard } from "./docker-disk";
import type { DiskLevel } from "../../shared/docker-disk.js";
import { entryText, type EntryKind } from "../../shared/entry.js";
import { phaseLabels } from "../../shared/observation.js";
import {
  systemStatusLabels,
  workerImageLabels,
  workerImageStatus,
} from "../../shared/status-glossary.js";
import {
  containerCondition,
  serviceKey,
  diskAttentionCount,
  readSystemTab,
  systemTabs,
  type SystemTab,
} from "../../shared/system-tabs.js";
import { EgressCard } from "./egress";
import { CheckEnvironmentCard } from "./check-environments";
import { FrictionCard } from "./friction";

type ContainerStatus = {
  name: string;
  role: string;
  image: string;
  state: string;
  status: string;
  created: string;
  phase?: string;
};
type WorkerImage = {
  tag: string;
  rev: string | null;
  current: boolean;
  sizeMb: number;
  created: string;
};
type Volumes = { jobs: number; sourceCaches: number };
/** 與 server/system-status.ts 的 SystemStatus 相同：讀不到 Docker 時清單為 null。 */
type SystemStatus = {
  checkedAt: string;
  requiredWorkerRev: string;
  runner: { state: "ok" | "docker" | "down"; detail?: string };
  services: ContainerStatus[] | null;
  jobs: ContainerStatus[] | null;
  images: WorkerImage[] | null;
  volumes: Volumes | null;
  /** 固定 HTTPS 入口的種類（server/tunnel-provider.ts 的 currentEntry）。 */
  entry?: EntryKind;
};
/** 上一次成功讀到的容器清單；之後讀不到時繼續顯示並標示時間。 */
type DockerLists = {
  checkedAt: string;
  services: ContainerStatus[];
  jobs: ContainerStatus[];
  images: WorkerImage[];
  volumes: Volumes;
};
type Tone = "good" | "warn" | "danger" | "idle";
const runnerTone = {
  ok: "good",
  docker: "warn",
  down: "danger",
  unavailable: "danger",
} as const;
const runnerAdvice = {
  docker:
    "執行器有回應，但讀不到 Docker 資料，可能是 Docker 忙碌或已停止。請確認 Docker Desktop 與主機可用記憶體，再按「重新整理」。",
  down: "執行器沒有回應，主機程序可能已停止或網路已中斷。請確認主機連線，稍候讓監督程序恢復執行器，再按「重新整理」。",
};
const containerTone = {
  running: "good",
  idle: "idle",
  unhealthy: "danger",
  stopped: "danger",
} as const;
const serviceNames: Record<string, string> = {
  app: "看板與排程",
  db: "資料庫",
  egress: "套件下載代理",
  "egress-ai": "AI 服務連線代理",
  "subscription-relay": "訂閱推論轉送",
  embedder: "本機向量模型",
  "db-test": "測試用資料庫",
};

export function SystemView({
  state,
  request,
  admin = false,
  tab,
  onTabChange,
}: {
  state: State;
  request: Request;
  admin?: boolean;
  tab: SystemTab;
  onTabChange: (tab: SystemTab) => void;
}) {
  const [status, setStatus] = useState<SystemStatus | null>(null),
    [lists, setLists] = useState<DockerLists | null>(null),
    [error, setError] = useState(false),
    [errorDetail, setErrorDetail] = useState(""),
    [loading, setLoading] = useState(false);
  const [diskLevel, setDiskLevel] = useState<DiskLevel | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await request<SystemStatus>("/api/system");
      setStatus(s);
      if (s.services && s.jobs && s.images && s.volumes)
        setLists({
          checkedAt: s.checkedAt,
          services: s.services,
          jobs: s.jobs,
          images: s.images,
          volumes: s.volumes,
        });
      setError(false);
      setErrorDetail("");
    } catch (e) {
      setError(true);
      setErrorDetail(message(e));
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  const services = (lists?.services ?? []).map((service) => ({
    service,
    condition: containerCondition(service),
  }));
  // 這次沒拿到清單（執行器或 Docker 沒回應、或看板讀取失敗）：沿用上一次的清單並標示時間。
  const stale = error || (!!status && !status.services);
  const images = (lists?.images ?? []).map((image) => {
    const usedBy = state.projects
      .filter((project) => project.image === image.tag)
      .map((project) => project.name);
    return {
      image,
      usedBy,
      status: workerImageStatus(image.current, usedBy.length > 0),
    };
  });
  const counts: Record<SystemTab, number> = {
    execution: Number(
      !state.settings.paused &&
        !state.diskDispatchPaused &&
        !!memoryHold(state),
    ),
    disk: diskAttentionCount({
      probeFailed: stale,
      services: services.map(({ condition }) => condition),
      images: images.map(({ status }) => status),
      diskLevel,
      diskPaused: state.diskDispatchPaused ?? false,
    }),
    network: 0,
    architecture: 0,
  };
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(readSystemTab(value))}
      className="min-w-0 gap-4"
    >
      <TabsList
        aria-label="系統分頁"
        className="h-auto max-w-full justify-start overflow-x-auto"
      >
        {(Object.entries(systemTabs) as [SystemTab, string][]).map(
          ([id, label]) => (
            <TabsTrigger
              key={id}
              value={id}
              className="h-auto min-h-11 flex-none gap-1.5 px-3 md:min-h-8"
            >
              {label}
              {counts[id] > 0 && (
                // 數字可見、說明給讀屏：可見文字要包含在名稱裡（axe label-content-name-mismatch）。
                <Badge variant="warn" className="px-1.5">
                  <span className="sr-only">
                    {" "}
                    {systemStatusLabels.attention}{" "}
                  </span>
                  {counts[id]}
                  <span className="sr-only"> 項</span>
                </Badge>
              )}
            </TabsTrigger>
          ),
        )}
      </TabsList>
      {/* 分頁切換時保留設定草稿；磁碟盤點也提供未開啟分頁的待處理數量。 */}
      <TabsContent
        value="execution"
        forceMount
        hidden={tab !== "execution"}
        className="space-y-6"
      >
        <CapacityCard request={request} />
        {admin && <FrictionCard state={state} request={request} />}
      </TabsContent>
      <TabsContent
        value="disk"
        forceMount
        hidden={tab !== "disk"}
        className="space-y-6"
      >
        <ContainerCard
          status={status}
          lists={lists}
          services={services}
          images={images}
          stale={stale}
          error={error}
          errorDetail={errorDetail}
          loading={loading}
          reload={load}
        />
        <DockerDiskCard
          request={request}
          active={tab === "disk"}
          onLevelChange={setDiskLevel}
        />
      </TabsContent>
      <TabsContent
        value="network"
        forceMount
        hidden={tab !== "network"}
        className="space-y-6"
      >
        <EgressCard request={request} />
        <CheckEnvironmentCard request={request} admin={admin} />
      </TabsContent>
      <TabsContent value="architecture">
        {status || error ? (
          <Architecture state={state} entry={status?.entry ?? "unknown"} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            正在讀取系統架構…
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}

function ContainerCard({
  status,
  lists,
  services,
  images,
  stale,
  error,
  errorDetail,
  loading,
  reload,
}: {
  status: SystemStatus | null;
  lists: DockerLists | null;
  services: {
    service: ContainerStatus;
    condition: ReturnType<typeof containerCondition>;
  }[];
  images: {
    image: WorkerImage;
    usedBy: string[];
    status: ReturnType<typeof workerImageStatus>;
  }[];
  stale: boolean;
  error: boolean;
  errorDetail: string;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const runner = error ? "unavailable" : status?.runner.state;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle role="heading" aria-level={2}>
            容器狀態
          </CardTitle>
          <CardDescription>
            {status
              ? `每 30 秒更新，最後更新 ${ago(status.checkedAt)}`
              : error
                ? "尚未取得狀態"
                : "讀取中…"}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw className={cn(loading && "animate-spin")} /> 重新整理
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            無法讀取容器狀態，可能是連線中斷或看板暫時無法取得資料。請按「重新整理」再試。
            {errorDetail && (
              <span className="mt-1 block text-xs break-words">
                錯誤重點：{errorDetail}
              </span>
            )}
          </p>
        )}
        {(runner === "down" || runner === "docker") && (
          <p
            role="status"
            className={cn(
              "rounded-lg px-3 py-2 text-sm",
              runner === "down"
                ? "bg-danger-soft text-danger"
                : "bg-warn-soft text-warn",
            )}
          >
            {runnerAdvice[runner]}
            {/* 伺服器已遮蔽機密；保留錯誤重點，管理者才知道是哪一步失敗。 */}
            {status?.runner.detail && (
              <span className="mt-1 block text-xs break-words">
                錯誤重點：{status.runner.detail}
              </span>
            )}
          </p>
        )}
        {runner && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">服務</h3>
            <ul className="divide-y rounded-lg border">
              <ServiceRow
                name="執行器"
                role="負責建立與回收工作容器的主機程序"
                tone={runnerTone[runner]}
                detail={systemStatusLabels.runner[runner]}
              />
              {services.map(({ service, condition }) => (
                <ServiceRow
                  key={service.name}
                  name={serviceNames[serviceKey(service.name)] ?? service.name}
                  role={service.role}
                  tone={containerTone[condition]}
                  detail={systemStatusLabels.container[condition]}
                />
              ))}
            </ul>
            {!stale &&
              services.some(
                ({ condition }) =>
                  condition !== "running" && condition !== "idle",
              ) && (
                <p className="text-xs text-danger">
                  有服務暫時無法使用，可能是容器已停止或健康檢查未通過。請在主機確認
                  Docker 中的服務狀態，再按「重新整理」。
                </p>
              )}
            {stale && (
              <p className="text-xs text-muted-foreground">
                {lists
                  ? `容器清單資料停在 ${ago(lists.checkedAt)}，恢復回應後會自動更新。`
                  : "尚未取得容器清單，恢復回應後會自動更新。"}
              </p>
            )}
          </section>
        )}
        {lists && (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                執行中的工作容器
              </h3>
              {lists.jobs.length ? (
                <ul className="divide-y rounded-lg border">
                  {lists.jobs.map((c) => {
                    const condition = containerCondition(c);
                    return (
                      <ServiceRow
                        key={c.name}
                        name={phaseLabels[c.phase ?? ""] ?? c.role}
                        role={`建立於 ${date(c.created)}，映像 ${c.image}`}
                        tone={containerTone[condition]}
                        detail={systemStatusLabels.container[condition]}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  目前沒有工作容器在執行。
                </p>
              )}
            </section>
            <section className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <section
                id="worker-images"
                aria-labelledby="worker-images-title"
                className="flex min-w-0 flex-col gap-2"
              >
                <h3
                  id="worker-images-title"
                  className="text-xs font-medium text-muted-foreground"
                >
                  工作映像（需要版本 {status?.requiredWorkerRev} 以後）
                </h3>
                <ul className="divide-y rounded-lg border">
                  {images.map(({ image, usedBy, status: imageStatus }) => (
                    <li
                      key={image.tag}
                      className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 text-sm"
                    >
                      <span className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
                        <code className="text-xs [overflow-wrap:anywhere]">
                          {image.tag}
                        </code>
                        {usedBy.length > 0 && (
                          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            使用中：{usedBy.join("、")}
                          </span>
                        )}
                        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span>{(image.sizeMb / 1024).toFixed(1)} GB</span>
                          <span>建立於 {date(image.created)}</span>
                        </span>
                      </span>
                      <Badge
                        variant={
                          imageStatus === "current"
                            ? "good"
                            : imageStatus === "outdated"
                              ? "warn"
                              : "secondary"
                        }
                        className="max-w-full whitespace-normal"
                      >
                        {imageStatus === "current"
                          ? workerImageLabels.current(image.rev)
                          : workerImageLabels[imageStatus]}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {images.some(({ status }) => status === "unused") && (
                  <p className="text-xs text-muted-foreground">
                    可在下方「Docker 磁碟」查看並清理符合清理規則的映像。
                  </p>
                )}
              </section>
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  磁碟上的工作資料
                </h3>
                <dl className="grid grid-cols-[1fr_auto] gap-y-2 rounded-lg border px-3 py-2.5 text-sm">
                  <dt className="text-muted-foreground">任務工作區</dt>
                  <dd className="tabular-nums">{lists.volumes.jobs} 個</dd>
                  <dt className="text-muted-foreground">原始碼快取</dt>
                  <dd className="tabular-nums">
                    {lists.volumes.sourceCaches} 個
                  </dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  任務工作區保留 30 天後由每小時的維護工作清除；可在下方「Docker
                  磁碟」開啟較短的保留規則。
                </p>
              </div>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ServiceRow({
  name,
  role,
  tone,
  detail,
}: {
  name: string;
  role: string;
  tone: Tone;
  detail: string;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "idle"
            ? "bg-border"
            : tone === "good"
              ? "bg-good"
              : tone === "warn"
                ? "bg-warn"
                : "bg-danger",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-anywhere text-sm font-medium">{name}</span>
        <span className="wrap-anywhere text-xs text-muted-foreground">
          {role}
        </span>
      </span>
      <span
        className={cn(
          "max-w-[40%] shrink-0 text-right text-xs",
          tone === "good" || tone === "idle"
            ? "text-muted-foreground"
            : tone === "warn"
              ? "text-warn"
              : "text-danger",
        )}
      >
        {detail}
      </span>
    </li>
  );
}

/* ---------- 系統架構 ---------- */

/**
 * 系統架構動畫（docs/architecture-flow.html，與看板一起建置）。看板 CSP 只允許同源，所以用同源 iframe 嵌入；
 * 外觀跟著看板的 .dark，固定 HTTPS 入口的種類由 /api/system 的 entry 決定，高度由動畫頁回報。
 */
function FlowAnimation({ entry }: { entry: EntryKind }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const isDark = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(isDark);
  const [initialTheme] = useState(() => (isDark() ? "dark" : "light"));
  const [height, setHeight] = useState(760);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()));
    o.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { type: "agentflow-flow-theme", theme: dark ? "dark" : "light" },
      location.origin,
    );
  }, [dark]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== ref.current?.contentWindow
      )
        return;
      const d = e.data as { type?: string; height?: unknown };
      if (d?.type === "agentflow-flow-height" && typeof d.height === "number")
        setHeight(Math.ceil(d.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={ref}
      title="系統架構動畫：一則 LINE 訊息怎麼變成 PR"
      src={`/docs/architecture-flow.html?embed=1&entry=${entry}&theme=${initialTheme}`}
      allow="fullscreen"
      className="w-full rounded-lg border-0 bg-transparent"
      style={{ height }}
    />
  );
}

function Architecture({ state, entry }: { state: State; entry: EntryKind }) {
  const open = state.settings.container_network === "open";
  const downloads = state.settings.code_downloads !== false;
  const permissionFields = ["做什麼", "網路", "工作區"];
  const permissions = [
    [
      "系統套件",
      "以 root 安裝審查放行的系統套件，存成專案衍生映像（同設定重用）",
      "下載來源白名單（系統頁可改）",
      "不掛載",
    ],
    ["安裝", "執行專案的安裝命令", "下載來源白名單（系統頁可改）", "可寫"],
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
    ["測試", "執行專案的測試命令", open ? "完全開放" : "無", "可寫"],
    [
      "審查",
      "另一個 Codex 獨立檢查",
      open ? "完全開放＋推論轉送" : "只有推論轉送",
      "唯讀",
    ],
  ];
  const permissionTone = (field: string, value: string) =>
    field === "網路" && value.startsWith("完全開放") && "text-warn";
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          系統架構
        </CardTitle>
        <CardDescription>
          按播放，跟著一則 LINE
          需求看它經過哪些元件、在每一步做什麼；下方是各階段的權限與資料位置。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <FlowAnimation entry={entry} />
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">一則需求的完整流程</h3>
          <ol className="flex flex-col gap-2 text-sm">
            {[
              [
                "收訊",
                `LINE 經${entryText[entry].name}送 Webhook 到 app，驗證簽章後存入資料庫；圖片在背景下載，原文保留 30 天。`,
              ],
              [
                "判讀",
                "純文字引用追問安靜 5 秒、一般需求安靜 60 秒（或累積 5 分鐘）後，app 在一次性 AI 容器裡彙整碎片訊息，參考近期對話、群組記憶與 RAG 檢索，判斷是否為需求、要改哪個專案，並套用固定風險規則；也可能自動記住新規則。",
              ],
              [
                "審核",
                "修改一律先確認，符合規則的查詢可自動排程；缺必要資訊時只問一件事，合理預設列入假設，產品方向不同才提供推薦選項，需確認的任務進收件匣並通知管理者。",
              ],
              [
                "開發",
                "執行器先取得原始碼並安裝相依套件，接著由 Codex 修改。系統收集差異後執行測試，最後進行獨立審查。失敗會自動修復一次，仍失敗就停下來交給你。",
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

        <section
          aria-labelledby="architecture-permissions"
          className="flex flex-col gap-2"
        >
          <h3 id="architecture-permissions" className="text-sm font-medium">
            工作容器各階段的權限
          </h3>
          <ul className="divide-y rounded-lg border md:hidden">
            {permissions.map(([phase, ...values]) => (
              <li key={phase} className="space-y-2 px-3 py-2.5 text-sm">
                <h4 className="font-medium">{phase}</h4>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {permissionFields.map((field, i) => (
                    <div
                      key={field}
                      className="grid grid-cols-subgrid col-span-2"
                    >
                      <dt className="text-muted-foreground">{field}</dt>
                      <dd
                        className={cn(
                          "wrap-anywhere",
                          permissionTone(field, values[i]),
                        )}
                      >
                        {values[i]}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden rounded-lg border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    階段
                  </th>
                  {permissionFields.map((field) => (
                    <th
                      key={field}
                      scope="col"
                      className="px-3 py-2 font-medium"
                    >
                      {field}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {permissions.map(([phase, ...values]) => (
                  <tr key={phase}>
                    <th
                      scope="row"
                      className="px-3 py-2 text-left font-medium whitespace-nowrap"
                    >
                      {phase}
                    </th>
                    {permissionFields.map((field, i) => (
                      <td
                        key={field}
                        className={cn(
                          "px-3 py-2 wrap-anywhere",
                          permissionTone(field, values[i]),
                        )}
                      >
                        {values[i]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section
          aria-labelledby="architecture-storage"
          className="flex flex-col gap-2"
        >
          <h3 id="architecture-storage" className="text-sm font-medium">
            資料存放位置
          </h3>
          <div className="rounded-lg border">
            <table className="w-full table-fixed text-sm">
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
                    <th
                      scope="row"
                      className="w-24 px-3 py-2 text-left font-medium sm:w-36"
                    >
                      {k}
                    </th>
                    <td className="px-3 py-2 font-mono text-xs wrap-anywhere text-muted-foreground">
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
