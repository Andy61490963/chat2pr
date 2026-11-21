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
import { cn } from "@/lib/utils";
import { type Request, type State, ago, date, message } from "./shared";
import { CapacityCard } from "./capacity";
import { DockerDiskCard } from "./docker-disk";
import { entryText, type EntryKind } from "../../shared/entry.js";
import {
  workerImageLabels,
  workerImageStatus,
} from "../../shared/status-glossary.js";
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
  runId?: string;
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
type Tone = "good" | "warn" | "danger";
const runnerView: Record<
  SystemStatus["runner"]["state"],
  { tone: Tone; label: string }
> = {
  ok: { tone: "good", label: "連線正常" },
  docker: { tone: "warn", label: "Docker 沒有回應" },
  down: { tone: "danger", label: "執行器沒有回應" },
};

export function SystemView({
  state,
  request,
  admin = false,
}: {
  state: State;
  request: Request;
  admin?: boolean;
}) {
  const [status, setStatus] = useState<SystemStatus | null>(null),
    [lists, setLists] = useState<DockerLists | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
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
  const runner = error
    ? { tone: "danger" as Tone, label: "無法讀取狀態" }
    : status
      ? runnerView[status.runner.state]
      : null;
  // 這次沒拿到清單（執行器或 Docker 沒回應、或看板讀取失敗）：沿用上一次的清單並標示時間。
  const stale = !!error || (!!status && !status.services);
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
  return (
    <div className="flex flex-col gap-6">
      <CapacityCard request={request} />
      {admin && <FrictionCard state={state} request={request} />}
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
            className="min-h-11"
            disabled={loading}
            onClick={() => void load()}
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
              {error}
            </p>
          )}
          {!error && status?.runner.detail && (
            <p
              role="status"
              className={cn(
                "rounded-lg px-3 py-2 text-sm",
                status.runner.state === "down"
                  ? "bg-danger-soft text-danger"
                  : "bg-warn-soft text-warn",
              )}
            >
              {status.runner.detail}
            </p>
          )}
          {runner && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                服務
              </h3>
              <ul className="divide-y rounded-lg border">
                <ServiceRow
                  name="執行器 runner"
                  role="主機上的程序（4312），負責建立與回收工作容器"
                  tone={runner.tone}
                  detail={runner.label}
                />
                {lists?.services.map((c) => (
                  <ServiceRow
                    key={c.name}
                    name={c.name.replace(/^line-agentflow-|-1$/g, "")}
                    role={c.role}
                    tone={c.state === "running" ? "good" : "danger"}
                    detail={c.status}
                  />
                ))}
              </ul>
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
                    {lists.jobs.map((c) => (
                      <ServiceRow
                        key={c.name}
                        name={c.name}
                        role={`執行 ${c.runId?.slice(0, 8) ?? ""} · ${c.image}`}
                        tone={c.state === "running" ? "good" : "danger"}
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
                    任務工作區保留 30
                    天後由每小時的維護工作清除；可在下方「Docker
                    磁碟」開啟較短的保留規則。
                  </p>
                </div>
              </section>
            </>
          )}
        </CardContent>
      </Card>
      <DockerDiskCard request={request} />
      <EgressCard request={request} />
      <CheckEnvironmentCard request={request} admin={admin} />
      <Architecture state={state} entry={status?.entry ?? "unknown"} />
    </div>
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
          tone === "good"
            ? "bg-good"
            : tone === "warn"
              ? "bg-warn"
              : "bg-danger",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{role}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-xs",
          tone === "good"
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
        <CardTitle>系統架構</CardTitle>
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
