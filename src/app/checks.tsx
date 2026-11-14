import { useCallback, useEffect, useState } from "react";
import type {
  CheckRunView,
  ScheduledCheck,
  SqlCondition,
} from "../../shared/checks";
import type { CheckEnvironmentView } from "../../shared/check-environment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import { type Request, type State, ago, date, message } from "./shared";

type Listed = ScheduledCheck & {
  last_summary: string | null;
  environment?: CheckEnvironmentView;
};

/** 檢查環境（#19）：每個檢查專用的檢查容器與網路，保留重用、閒置逾時才清除。 */
function environmentText(e: CheckEnvironmentView | undefined) {
  if (!e) return null;
  if (e.state === "kept")
    return `保留中・上次使用 ${ago(e.lastUsedAt)}・預計 ${date(e.expiresAt)} 清除`;
  if (e.state === "failed") return `建立失敗（${date(e.at)}）：${e.message}`;
  if (e.state === "unknown") return `狀態不明：${e.detail}`;
  return "未建立（下次執行時建立）";
}

const statusLabel: Record<
  ScheduledCheck["status"],
  [string, "warn" | "good" | "secondary" | "danger"]
> = {
  awaiting_approval: ["待核准", "warn"],
  active: ["執行中", "good"],
  paused: ["已暫停", "secondary"],
  failed: ["檢查失敗已暫停", "danger"],
};
const stateLabel: Record<
  ScheduledCheck["state"],
  [string, "good" | "danger" | "secondary"]
> = {
  unknown: ["尚未判定", "secondary"],
  ok: ["正常", "good"],
  alert: ["異常", "danger"],
};
const kindLabel = {
  sql: "SQL 唯讀查詢",
  http: "HTTP 健康檢查",
  tcp: "TCP 連線",
};
const schedule = (c: Pick<ScheduledCheck, "interval_minutes" | "daily_at">) =>
  c.interval_minutes
    ? `每 ${c.interval_minutes} 分鐘`
    : `每天 ${c.daily_at}（臺北時間）`;

const blank = {
  group_id: "",
  project_id: "",
  name: "",
  kind: "sql" as ScheduledCheck["kind"],
  target: "",
  column: "",
  op: ">" as SqlCondition["op"],
  value: "0",
  listColumn: "",
  contains: "",
  every: "60",
  mode: "interval" as "interval" | "daily",
  daily_at: "08:00",
  notify: "both" as ScheduledCheck["notify"],
  quiet_from: "",
  quiet_to: "",
  alert_text: "",
  recovered_text: "",
  rationale: "",
  investigate: true,
};
type Draft = typeof blank;

const toDraft = (c: ScheduledCheck): Draft => {
  const cond = c.condition as Partial<SqlCondition> & { contains?: string };
  return {
    group_id: c.group_id,
    project_id: c.project_id ?? "",
    name: c.name,
    kind: c.kind,
    target: c.target,
    column: cond.column ?? "",
    op: cond.op ?? ">",
    value: String(cond.value ?? "0"),
    listColumn: cond.listColumn ?? "",
    contains: cond.contains ?? "",
    every: String(c.interval_minutes ?? 60),
    mode: c.interval_minutes ? "interval" : "daily",
    daily_at: c.daily_at ?? "08:00",
    notify: c.notify,
    quiet_from: c.quiet_from ?? "",
    quiet_to: c.quiet_to ?? "",
    alert_text: c.alert_text,
    recovered_text: c.recovered_text,
    rationale: c.rationale,
    investigate: c.investigate,
  };
};
const toBody = (d: Draft) => ({
  group_id: d.group_id,
  project_id: d.project_id || null,
  name: d.name,
  kind: d.kind,
  target: d.target,
  condition:
    d.kind === "sql"
      ? {
          column: d.column,
          op: d.op,
          value: Number.isNaN(Number(d.value)) ? d.value : Number(d.value),
          ...(d.listColumn ? { listColumn: d.listColumn } : {}),
        }
      : d.kind === "http" && d.contains
        ? { contains: d.contains }
        : {},
  interval_minutes: d.mode === "interval" ? Number(d.every) : null,
  daily_at: d.mode === "daily" ? d.daily_at : null,
  notify: d.notify,
  quiet_from: d.quiet_from || null,
  quiet_to: d.quiet_to || null,
  alert_text: d.alert_text,
  recovered_text: d.recovered_text,
  rationale: d.rationale,
  investigate: d.investigate,
});

const field = "rounded-md border bg-background px-2 py-1.5 text-sm";

function CheckForm({
  state,
  initial,
  busy,
  submit,
  cancel,
}: {
  state: State;
  initial: Draft;
  busy: boolean;
  submit: (d: Draft) => void;
  cancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const projects = state.projects.filter((p) =>
    state.groups.find((g) => g.id === d.group_id)?.project_ids?.includes(p.id),
  );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(d);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="flex flex-col gap-1">
          名稱
          <Input
            value={d.name}
            maxLength={80}
            onChange={(e) => set("name", e.target.value)}
            placeholder="機台狀態回報是否中斷"
          />
        </Label>
        <Label className="flex flex-col gap-1">
          通知群組
          <select
            className={field}
            value={d.group_id}
            onChange={(e) => set("group_id", e.target.value)}
          >
            <option value="">選擇群組…</option>
            {state.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Label>
        <Label className="flex flex-col gap-1">
          檢查方式
          <select
            className={field}
            value={d.kind}
            onChange={(e) => set("kind", e.target.value as Draft["kind"])}
          >
            <option value="sql">SQL 唯讀查詢（使用專案登記的資料庫）</option>
            <option value="http">HTTP 健康檢查</option>
            <option value="tcp">TCP 連線</option>
          </select>
        </Label>
        <Label className="flex flex-col gap-1">
          專案{d.kind === "sql" ? "（必填）" : "（選填，用於異常時請 AI 調查）"}
          <select
            className={field}
            value={d.project_id}
            onChange={(e) => set("project_id", e.target.value)}
          >
            <option value="">不指定</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Label>
      </div>
      <Label className="flex flex-col gap-1">
        {d.kind === "sql"
          ? "SELECT 查詢（只能讀取，會在一定回滾的交易中執行）"
          : d.kind === "http"
            ? "網址"
            : "主機:連接埠"}
        {d.kind === "sql" ? (
          <Textarea
            rows={4}
            className="font-mono text-xs"
            value={d.target}
            onChange={(e) => set("target", e.target.value)}
            placeholder="SELECT COUNT(*) AS stale FROM EQM_STATUS WHERE last_report < DATEADD(minute,-30,GETDATE())"
          />
        ) : (
          <Input
            value={d.target}
            onChange={(e) => set("target", e.target.value)}
            placeholder={
              d.kind === "http" ? "http://10.0.0.5/health" : "10.0.0.21:502"
            }
          />
        )}
      </Label>
      {d.kind === "sql" && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <span>當第一列的</span>
          <Input
            className="w-32"
            value={d.column}
            onChange={(e) => set("column", e.target.value)}
            placeholder="欄位（$rows=筆數）"
          />
          <select
            className={field}
            value={d.op}
            onChange={(e) => set("op", e.target.value as Draft["op"])}
          >
            {([">", ">=", "<", "<=", "=", "!="] as const).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <Input
            className="w-24"
            value={d.value}
            onChange={(e) => set("value", e.target.value)}
          />
          <span>時算異常，通知列出</span>
          <Input
            className="w-32"
            value={d.listColumn}
            onChange={(e) => set("listColumn", e.target.value)}
            placeholder="欄位（選填）"
          />
        </div>
      )}
      {d.kind === "http" && (
        <Label className="flex flex-col gap-1">
          回應需包含的文字（選填；非 2xx、逾時或不包含就算異常）
          <Input
            value={d.contains}
            onChange={(e) => set("contains", e.target.value)}
          />
        </Label>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          className={field}
          value={d.mode}
          onChange={(e) => set("mode", e.target.value as Draft["mode"])}
        >
          <option value="interval">固定間隔</option>
          <option value="daily">每天固定時間</option>
        </select>
        {d.mode === "interval" ? (
          <>
            每{" "}
            <Input
              className="w-20"
              type="number"
              min={15}
              value={d.every}
              onChange={(e) => set("every", e.target.value)}
            />{" "}
            分鐘（最短 15）
          </>
        ) : (
          <>
            每天{" "}
            <Input
              className="w-24"
              value={d.daily_at}
              onChange={(e) => set("daily_at", e.target.value)}
            />
            （臺北時間）
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        通知
        <select
          className={field}
          value={d.notify}
          onChange={(e) => set("notify", e.target.value as Draft["notify"])}
        >
          <option value="both">群組與管理者私訊</option>
          <option value="group">只發群組</option>
          <option value="admin">只私訊管理者</option>
        </select>
        靜音時段（只通知管理者）
        <Input
          className="w-20"
          value={d.quiet_from}
          onChange={(e) => set("quiet_from", e.target.value)}
          placeholder="22:00"
        />
        到
        <Input
          className="w-20"
          value={d.quiet_to}
          onChange={(e) => set("quiet_to", e.target.value)}
          placeholder="07:00"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="flex flex-col gap-1">
          異常時的訊息（選填）
          <Input
            value={d.alert_text}
            onChange={(e) => set("alert_text", e.target.value)}
            placeholder="有機台超過 30 分鐘沒有回報"
          />
        </Label>
        <Label className="flex flex-col gap-1">
          恢復時的訊息（選填）
          <Input
            value={d.recovered_text}
            onChange={(e) => set("recovered_text", e.target.value)}
            placeholder="機台回報已恢復正常"
          />
        </Label>
      </div>
      <Label className="flex flex-col gap-1">
        判斷依據（給核准者看）
        <Textarea
          rows={2}
          value={d.rationale}
          onChange={(e) => set("rationale", e.target.value)}
        />
      </Label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={d.investigate}
          onCheckedChange={(v) => set("investigate", v === true)}
        />
        變成異常時自動請 AI 調查可能原因（每天最多一次，會用 Codex 額度）
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          儲存（需要核准才會執行）
        </Button>
        <Button type="button" variant="ghost" onClick={cancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

/** 定期檢查頁：列出每個檢查的狀態與最近結果；管理者可以建立、試跑、核准、暫停與修改。 */
export function ChecksView({
  state,
  request,
  admin,
}: {
  state: State;
  request: Request;
  admin: boolean;
}) {
  const [checks, setChecks] = useState<Listed[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<CheckRunView[]>([]);
  const [editing, setEditing] = useState<ScheduledCheck | "new" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setChecks(await request<Listed[]>("/api/checks"));
    } catch (e) {
      setNote(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    void request<{ runs: CheckRunView[] }>(`/api/checks/${open}`)
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]));
  }, [open, request, checks]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };
  const groupName = (id: string) =>
    state.groups.find((g) => g.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>定期檢查</CardTitle>
            <CardDescription>
              核准後依排程自動執行，不呼叫
              AI；狀態改變（變成異常、恢復正常）時才通知。檢查本身連續失敗 3
              次會暫停並通知管理者。每個檢查在自己的檢查容器執行，網路只通到該檢查的目標；環境保留重用，閒置逾時（系統頁設定）或檢查、連線變更時清除。
            </CardDescription>
          </div>
          {admin && editing === null && (
            <Button onClick={() => setEditing("new")}>新增定期檢查</Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {note && (
            <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
              {note}
            </p>
          )}
          {editing && (
            <CheckForm
              state={state}
              busy={busy}
              initial={editing === "new" ? blank : toDraft(editing)}
              cancel={() => setEditing(null)}
              submit={(d) =>
                void act(async () => {
                  if (editing === "new")
                    await request("/api/checks", "POST", toBody(d));
                  else
                    await request(`/api/checks/${editing.id}`, "PUT", {
                      version: editing.version,
                      ...toBody(d),
                    });
                  setEditing(null);
                }, "已儲存，請試跑確認後核准")
              }
            />
          )}
          {!checks.length && !editing && (
            <p className="text-sm text-muted-foreground">
              還沒有定期檢查。可以在群組說「/任務
              每小時檢查一次機台連線」，或由管理者在這裡新增。
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {checks.map((c) => (
              <li key={c.id} className="rounded-lg border">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {c.name}
                  </span>
                  <Badge variant={stateLabel[c.state][1]}>
                    {stateLabel[c.state][0]}
                  </Badge>
                  <Badge variant={statusLabel[c.status][1]}>
                    {statusLabel[c.status][0]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {kindLabel[c.kind]}・{schedule(c)}・{groupName(c.group_id)}
                  </span>
                </button>
                {open === c.id && (
                  <div className="flex flex-col gap-2 border-t px-3 py-3 text-sm">
                    <p className="break-all font-mono text-xs">{c.target}</p>
                    {c.rationale && (
                      <p className="text-muted-foreground">
                        判斷依據：{c.rationale}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      上次：
                      {c.last_run_at
                        ? `${ago(c.last_run_at)}・${c.last_summary ?? ""}`
                        : "尚未執行"}
                      {c.next_run_at && `　下次：${date(c.next_run_at)}`}
                      　第 {c.version} 版
                      {c.approved_by ? `・${c.approved_by} 核准` : ""}
                    </p>
                    {c.environment && (
                      <p
                        className={`text-xs ${c.environment.state === "failed" ? "text-danger" : "text-muted-foreground"}`}
                      >
                        檢查環境：{environmentText(c.environment)}
                      </p>
                    )}
                    {runs.length > 0 && (
                      <ol
                        className="flex flex-wrap gap-1"
                        aria-label="最近結果"
                      >
                        {[...runs].reverse().map((r) => (
                          <li
                            key={r.id}
                            title={`${date(r.started_at)} ${r.summary}`}
                            className={`size-3 rounded-full ${r.outcome === "ok" ? "bg-good" : r.outcome === "alert" ? "bg-danger" : "bg-warn"}`}
                          />
                        ))}
                      </ol>
                    )}
                    {admin && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const r = await request<{
                                outcome: string;
                                summary: string;
                              }>(`/api/checks/${c.id}/test`, "POST");
                              setNote(
                                `試跑結果：${r.outcome === "ok" ? "正常" : r.outcome === "alert" ? "異常" : "執行失敗"}・${r.summary}`,
                              );
                            }, "")
                          }
                        >
                          試跑
                        </Button>
                        {c.status === "awaiting_approval" && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () =>
                                  request(
                                    `/api/checks/${c.id}/approve`,
                                    "POST",
                                    { version: c.version },
                                  ),
                                "已核准，開始依排程執行",
                              )
                            }
                          >
                            核准並啟用
                          </Button>
                        )}
                        {(c.status === "active" || c.status === "failed") && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () =>
                                  request(`/api/checks/${c.id}/pause`, "POST"),
                                "已暫停",
                              )
                            }
                          >
                            暫停
                          </Button>
                        )}
                        {(c.status === "paused" || c.status === "failed") &&
                          c.approved_version === c.version && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () =>
                                    request(
                                      `/api/checks/${c.id}/resume`,
                                      "POST",
                                    ),
                                  "已恢復",
                                )
                              }
                            >
                              恢復
                            </Button>
                          )}
                        {c.environment?.state === "kept" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () =>
                                  request(
                                    `/api/checks/${c.id}/environment/clear`,
                                    "POST",
                                  ),
                                "已清除檢查環境，下次執行時重新建立",
                              )
                            }
                          >
                            立即清除環境
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing(c)}
                        >
                          修改
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`刪除「${c.name}」？`))
                              void act(
                                () => request(`/api/checks/${c.id}`, "DELETE"),
                                "已刪除",
                              );
                          }}
                        >
                          刪除
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
