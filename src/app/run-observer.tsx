import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunEvent, RunView } from "../../shared/observation.js";
import { upstreamFailureText } from "../../shared/upstream-failure.js";
import { heartbeatStale } from "../../shared/run-progress.js";
import { InstallReportView } from "./egress";
import {
  eventLabels,
  longestPhase,
  phaseDurations,
  phaseLabels,
  phaseMinutes,
  runEventKind,
} from "../../shared/observation.js";
import { statusLabels, type TaskStatus } from "../../shared/types.js";
import { notificationLabels } from "../../shared/status-glossary.js";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readApiResponse } from "./api-response";
import { duration } from "./shared";
import { pickRun, pinFor } from "../../shared/run-pick.js";

type Page = {
  events: RunEvent[];
  hasOlder: boolean;
  nextBefore: number | null;
};
const time = (s: string) =>
  new Date(s).toLocaleString("zh-TW", { hour12: false });

function EventHeading({ event }: { event: RunEvent }) {
  const { phase, exitCode } = event;
  const kind = runEventKind(event);
  const label = eventLabels[kind] ?? kind;
  const failed = kind === "error" ||
    (kind !== "reconnect_rejected" && exitCode != null && exitCode !== 0);
  return (
    <p className={`flex flex-wrap gap-x-3 gap-y-1 wrap-anywhere ${failed ? "text-danger" : "font-medium"}`}>
      <span>{phaseLabels[phase] ?? phase}</span>
      <span>{label}</span>
      {exitCode != null && <span>結束碼 {exitCode}</span>}
      {kind === "worker_event_rejected" && event.rejectedCount != null && (
        <span>累計 {event.rejectedCount} 筆</span>
      )}
    </p>
  );
}
// 這次執行本身的結果；任務之後的狀態（合併、關閉）看任務標頭，不寫在這裡。
const runOutcomes: Record<string, string> = {
  ready: "已建立 PR",
  merged: "已建立 PR",
  closed: "已建立 PR",
  answered: "已回覆查詢",
  failed: "未完成，需要處理",
  cancelled: "已取消",
  budget_wait: "額度不足，已保留",
  auto_resumed: notificationLabels.autoResumed,
};
// brief：下拉選單用的短版，舊紀錄沒有結果時只寫「結果未保存」。
const outcomeText = (run: RunView, brief = false) =>
  run.outcome === "interrupted"
    ? "服務中斷"
    : run.outcome
      ? (runOutcomes[run.outcome] ??
        statusLabels[run.outcome as TaskStatus] ??
        run.outcome)
      : run.completed_at
        ? brief
          ? "結果未保存"
          : "舊紀錄未保存，請參考時間軸"
        : "執行中";

/** 各階段花費時間與距離單次執行上限還剩多少（#256）；執行中的最後一段算到現在。 */
function PhaseTimes({ run }: { run: RunView }) {
  if (!run.phases?.length) return null;
  const end = run.completed_at ?? new Date().toISOString();
  const spans = phaseDurations(run.phases, end);
  const top = longestPhase(spans);
  const limit = Date.parse(run.deadline) - Date.parse(run.started_at);
  const left = Date.parse(run.deadline) - Date.parse(end);
  return (
    <section className="mt-3 text-xs" aria-labelledby={`phase-times-${run.id}`}>
      <h4 id={`phase-times-${run.id}`} className="font-medium">
        各階段花費時間
      </h4>
      <dl className="mt-1 grid grid-cols-run-details gap-x-2 gap-y-1">
        {spans.map((span) => (
          <Fragment key={span.group}>
            <dt>{span.label}</dt>
            <dd className="tabular-nums">
              {phaseMinutes(span.ms)}
              {spans.length > 1 && span === top && "（最多）"}
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-1 text-muted-foreground">
        單次執行上限 {phaseMinutes(limit)}，
        {left >= 60000
          ? `距離上限還剩 ${phaseMinutes(left)}`
          : left > 0
            ? "距離上限不到 1 分鐘"
            : "已用完單次執行時間"}
      </p>
    </section>
  );
}

export function RunObserver({
  taskId,
  runs,
}: {
  taskId: string;
  runs: RunView[];
}) {
  // null 代表跟隨最新：重試後新執行排到最前面，畫面自動切過去；手動選了舊紀錄才固定在那次。
  const [pinned, setPinned] = useState<string | null>(null);
  // 「較早紀錄」的游標綁在當時那次執行上，切到別次執行時不會沿用。
  const [cursor, setCursor] = useState<{ run: string; before: number } | null>(
    null,
  );
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [received, setReceived] = useState<string | null>(null);
  const run = pickRun(runs, pinned);
  const before = cursor && cursor.run === run?.id ? cursor.before : undefined;
  const newer = !!run && !!runs[0] && runs[0].id !== run.id;
  useEffect(() => {
    if (!run) return;
    let disposed = false,
      loading = false;
    const abort = new AbortController();
    setPage(null);
    setError("");
    setReceived(null);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const r = await fetch(
          `/api/tasks/${taskId}/runs/${run.id}/events${before ? `?before=${before}` : ""}`,
          { signal: abort.signal, cache: "no-store" },
        );
        const data = await readApiResponse<Page>(r);
        if (!disposed) {
          setPage(data);
          setError("");
          setReceived(new Date().toISOString());
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "進度連線中斷");
      } finally {
        loading = false;
      }
    };
    void load();
    const events =
      !before && !run.completed_at ? new EventSource("/api/events") : null;
    events?.addEventListener("update", () => void load());
    events?.addEventListener("error", () => {
      if (!disposed)
        setError("進度連線中斷，正在重新連線；最後紀錄不代表工作已停止");
    });
    events?.addEventListener("connected", () => void load());
    return () => {
      disposed = true;
      abort.abort();
      events?.close();
    };
  }, [taskId, run?.id, run?.completed_at, before]);
  const stale = run && !run.completed_at && heartbeatStale(run.heartbeat_at);
  // 即時模式（看最新、執行未結束）且使用者原本就在底部附近時，新事件進來自動捲到最新；
  // 翻閱較早紀錄或往上捲著看時不動。
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const live = !!run && !before && !run.completed_at;
  // 換到另一次執行或按「回到最新」時，重新從最新開始跟。
  useEffect(() => {
    atBottom.current = true;
  }, [run?.id, before]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && live && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [page, live]);
  return (
    <section
      className="min-w-0 rounded-md border p-3"
      aria-label="Codex 執行紀錄"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Codex 執行紀錄</h3>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">唯讀</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        查看執行進度與診斷資訊；此處無法下指令或操作 Codex。
      </p>
      <dl className="text-xs">
        <dt className="text-muted-foreground">任務 ID</dt>
        <dd className="select-all break-all font-mono">{taskId}</dd>
      </dl>
      {!run ? (
        <p className="mt-3 text-sm text-muted-foreground">
          尚未派工，還沒有 Codex 執行紀錄。
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-1 text-xs">
            <span id="run-picker">執行紀錄（最多顯示最近 50 次）</span>
            <Select
              value={run.id}
              onValueChange={(v) => {
                setPinned(pinFor(runs, v));
                setCursor(null);
              }}
            >
              <SelectTrigger
                aria-labelledby="run-picker"
                className="min-h-9 w-full min-w-0 whitespace-normal data-[size=default]:h-auto"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {runs.map((r, i) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-left wrap-anywhere">
                      {i === 0 && <span>最新</span>}
                      <time dateTime={r.started_at}>{time(r.started_at)}</time>
                      <span>{outcomeText(r, true)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {newer && (
              <Button
                variant="link"
                size="xs"
                className="h-auto self-start p-0"
                onClick={() => {
                  setPinned(null);
                  setCursor(null);
                }}
              >
                有較新的執行，切換到最新
              </Button>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-run-details gap-x-2 gap-y-1 text-xs">
            <dt>執行 ID</dt>
            <dd className="select-all break-all font-mono">{run.id}</dd>
            <dt>模型設定</dt>
            <dd className="break-all">{run.model}</dd>
            <dt>{run.completed_at ? "最後階段" : "目前階段"}</dt>
            <dd>{phaseLabels[run.status] ?? run.status}</dd>
            <dt>執行結果</dt>
            <dd>{outcomeText(run)}</dd>
            {run.upstream_failure && (
              <>
                <dt>訂閱失敗原因</dt>
                <dd className="text-danger">{upstreamFailureText(run.upstream_failure)}</dd>
              </>
            )}
            <dt>開始時間</dt>
            <dd>{time(run.started_at)}</dd>
            <dt>{run.completed_at ? "結束時間" : "執行期限"}</dt>
            <dd>{time(run.completed_at ?? run.deadline)}</dd>
            <dt>耗時</dt>
            <dd>
              {duration(
                (run.completed_at
                  ? new Date(run.completed_at).getTime()
                  : Date.now()) - new Date(run.started_at).getTime(),
              )}
            </dd>
            <dt>服務心跳</dt>
            <dd>
              {time(run.heartbeat_at)}
              {stale && "（已超過 30 秒，狀態待確認）"}
            </dd>
          </dl>
          <PhaseTimes run={run} />
          {run.threads?.length > 0 && (
            <div className="mt-3 text-xs">
              <p className="font-medium">Codex thread ID</p>
              {run.threads.map((t, i) => (
                <p
                  key={`${t.threadId}-${i}`}
                  className="mt-1 select-all break-all font-mono"
                >
                  {phaseLabels[t.phase]}：{t.threadId}
                </p>
              ))}
            </div>
          )}
          {run.install_report && (
            <div className="mt-3">
              <InstallReportView report={run.install_report} />
            </div>
          )}
          {!run.observed && (
            <p className="mt-3 rounded bg-warn-soft p-2 text-xs text-warn">
              這次執行早於紀錄功能，未保存 Codex thread ID、容器 ID
              與階段輸出，無法補回歷史內容。
            </p>
          )}
          {run.observed && run.completed_at && !run.threads?.length && (
            <p className="mt-3 text-xs text-muted-foreground">
              這次執行未回報 Codex thread ID；請依階段紀錄確認是否已進入開發。
            </p>
          )}
          {error && (
            <p role="status" className="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
          {received && (
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {before
                  ? "歷史紀錄"
                  : run.completed_at
                    ? "執行已結束"
                    : "即時更新"}
              </span>
              <span>
                更新於 <time dateTime={received}>{time(received)}</time>
              </span>
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {page?.hasOlder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCursor({ run: run.id, before: page.nextBefore! })
                }
              >
                較早紀錄
              </Button>
            )}
            {before && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCursor(null)}
              >
                回到最新
              </Button>
            )}
          </div>
          <ol
            ref={list}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="mt-3 flex max-h-128 flex-col gap-3 overflow-y-auto text-xs"
            aria-label="執行事件"
          >
            {/* 事件依發生時間排列；進度連線恢復後補抓的事件不會排在較晚的紀錄後面。 */}
            {[...(page?.events ?? [])]
              .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
              .map((e) => (
                <li key={e.seq} className="min-w-0">
                  <EventHeading event={e} />
                  <p className="text-muted-foreground">{time(e.at)}</p>
                  {e.threadId && (
                    <p className="mt-1 select-all break-all font-mono">
                      Codex thread ID：{e.threadId}
                    </p>
                  )}
                  {e.containerId && (
                    <p className="mt-1 select-all break-all font-mono">
                      容器 ID：{e.containerId}
                    </p>
                  )}
                  {e.detail && (
                    <details className="mt-1">
                      <summary className="cursor-pointer">檢視內容</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">
                        {e.detail}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
          </ol>
          {run.observed && page?.events.length === 0 && (
            <p className="text-xs text-muted-foreground">尚未收到執行事件。</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            輸出為有長度上限的診斷片段，來源撤回或到期後清除；不包含完整提示詞、登入檔或內部推理。
          </p>
        </>
      )}
    </section>
  );
}
