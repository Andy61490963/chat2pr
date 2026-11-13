import { useCallback, useEffect, useState } from "react";
import type { Capacity } from "../../shared/capacity.js";
import { phaseLabels } from "../../shared/observation.js";
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
import { type Request, ago, message } from "./shared";

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const kind = (mode: string) => (mode === "query" ? "查詢" : "修改");

/** 系統頁：同時執行數設定、正在跑的任務與排隊順序（#21）。 */
export function CapacityCard({ request }: { request: Request }) {
  const [data, setData] = useState<Capacity | null>(null),
    [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = await request<Capacity>("/api/capacity");
      setData(d);
      setValue((v) => v || String(d.maxRuns));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);
  const save = async () => {
    setBusy(true);
    try {
      await request("/api/capacity", "PUT", { max_runs: Number(value) });
      setValue("");
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const host = data?.host;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle>同時執行</CardTitle>
        <CardDescription>
          全系統最多同時執行幾個任務；同一專案的修改一次一個，查詢可以並行。每個工作容器仍有
          2 GB 記憶體、2 顆 CPU 的上限。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {data?.hold && (
          <p
            role="status"
            className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn"
          >
            {data.hold}
          </p>
        )}
        {data && (
          <>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="flex flex-col gap-2 text-sm">
                <span>同時執行數</span>
                <Input
                  type="number"
                  className="w-28"
                  min={1}
                  max={data.cap}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
              <Button
                disabled={
                  busy ||
                  !value ||
                  Number(value) === data.maxRuns ||
                  Number(value) < 1 ||
                  Number(value) > data.cap
                }
              >
                儲存
              </Button>
              <span className="text-xs text-muted-foreground">
                目前 {data.maxRuns}（預設 {data.defaultRuns}，最多 {data.cap}）
                {data.suggested !== null &&
                  `；依主機建議不超過 ${data.suggested}`}
                {host &&
                  `（${host.dockerCpus ?? host.cpus} 顆 CPU、${gb(host.dockerMemMb ?? host.memTotalMb)} 記憶體，可用 ${gb(host.memFreeMb)}）`}
                。可用記憶體低於 {gb(data.memoryFloorMb)} 時暫停派新工作。
              </span>
            </form>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                執行中（{data.running.length}／{data.maxRuns}）
              </h3>
              {data.running.length ? (
                <ul className="divide-y rounded-lg border">
                  {data.running.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <Badge variant={r.mode === "query" ? "info" : "default"}>
                        {kind(r.mode)}
                      </Badge>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{r.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {r.project ?? "未指定專案"} ·{" "}
                          {phaseLabels[r.phase] ?? r.phase} ·{" "}
                          {ago(r.started_at)}
                          開始
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  目前沒有任務在執行。
                </p>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                排隊順序
              </h3>
              {data.queued.length ? (
                <ol className="divide-y rounded-lg border">
                  {data.queued.map((t, i) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <span className="w-6 text-right tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <Badge variant={t.mode === "query" ? "info" : "default"}>
                        {kind(t.mode)}
                      </Badge>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{t.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t.project ?? "未指定專案"} · {ago(t.created_at)}
                          提出
                        </span>
                      </span>
                      <Badge
                        variant={t.reason === "即將開始" ? "good" : "warn"}
                      >
                        {t.reason}
                      </Badge>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  沒有排隊中的任務。
                </p>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
