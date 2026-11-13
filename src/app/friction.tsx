import { useCallback, useEffect, useState } from "react";
import type { FrictionMetrics } from "../../shared/friction";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type Request, type State, message } from "./shared";

const duration = (seconds: number | null) => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分鐘`;
  return `${(seconds / 3600).toFixed(1)} 小時`;
};
const times = (v: number | null) => (v === null ? "—" : `${v} 次`);

/** 系統頁：使用者「有沒有感覺到流程」的指標，數字越低越好（時間越短越好）。 */
export function FrictionCard({
  state,
  request,
}: {
  state: State;
  request: Request;
}) {
  const [days, setDays] = useState(7);
  const [group, setGroup] = useState("");
  const [data, setData] = useState<FrictionMetrics | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ days: String(days) });
      if (group) q.set("group_id", group);
      setData(await request<FrictionMetrics>(`/api/metrics/friction?${q}`));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [request, days, group]);
  useEffect(() => void load(), [load]);
  const rows: [string, string, string][] = data
    ? [
        [
          "每件任務需要人回應",
          times(data.responsesPerTask),
          "核准、補充、回答補問、改接等，越少越好",
        ],
        [
          "每件任務要切到看板",
          times(data.dashboardPerTask),
          "必須打開看板才能繼續的次數；LINE 回答補問不算",
        ],
        [
          "重講背景",
          `${data.restated} 次`,
          "沒有接上前一題，30 分鐘內又重新指名同一個專案",
        ],
        ["接錯題", `${data.relinked} 次`, "使用者改正接續對象的次數"],
        [
          "第一則群組訊息",
          duration(data.firstReplySeconds),
          "從訊息送出到機器人在群組的第一則推播（中位數；「收到」不留紀錄，不含在內）",
        ],
        [
          "查詢拿到答案",
          duration(data.answerSeconds),
          "從提出到回答（中位數）",
        ],
        [
          "修改返工率",
          data.reworkRate === null
            ? "—"
            : `${Math.round(data.reworkRate * 100)}%（${data.reworkBase} 件）`,
          "合併後 7 天內同一需求又追加修改的比例",
        ],
      ]
    : [];
  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>使用摩擦</CardTitle>
          <CardDescription>
            {data ? `近 ${data.days} 天建立的 ${data.tasks} 件任務` : "讀取中…"}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <select
            aria-label="期間"
            className="rounded-md border bg-background px-2 py-1"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
          <select
            aria-label="群組"
            className="rounded-md border bg-background px-2 py-1"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">全部群組</option>
            {state.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <ul className="divide-y rounded-lg border">
          {rows.map(([label, value, hint]) => (
            <li
              key={label}
              className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="text-sm font-medium sm:w-40">{label}</span>
              <span className="text-sm tabular-nums sm:w-32">{value}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
