import {
  DataList,
  InlineNotice,
  ListRow,
  SectionHeader,
  Toolbar,
} from "@/components/ui/layout";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form-controls";
import { useEffect, useState } from "react";
import {
  maxExcludedGroups,
  minP95Samples,
  type FrictionMetrics,
} from "../../shared/friction";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
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
  const [excluded, setExcluded] = useState<string[]>([]);
  const [data, setData] = useState<FrictionMetrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ days: String(days) });
    if (group.startsWith("id:")) query.set("group_id", group.slice(3));
    if (group === "exclude")
      excluded.forEach((id) => query.append("exclude_group_id", id));
    setError("");
    setLoading(true);
    void request<FrictionMetrics>(`/api/metrics/friction?${query}`).then(
      (result) => {
        if (current) {
          setData(result);
          setLoading(false);
        }
      },
      (reason) => {
        if (current) {
          setError(message(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [request, days, group, excluded]);
  const scope = data?.groupId
    ? (state.groups.find((item) => item.id === data.groupId)?.name ??
      "單一群組")
    : data?.excludedGroupIds.length
      ? `全部群組，排除 ${data.excludedGroupIds.length} 個`
      : "全部群組";
  const waitHint = (samples: number, sources: number, tail: number | null) =>
    `中位數，樣本 ${samples} 筆，其中 ${sources} 筆有來源。第 95 百分位：${samples < minP95Samples ? "樣本不足" : duration(tail)}`;
  const rows: [string, string, string][] = data
    ? [
        [
          "每件任務需要人回應",
          times(data.responsesPerTask),
          "核准、補充、回答補問或選擇上一題的次數",
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
          `${waitHint(data.firstReplySamples, data.firstReplySources, data.firstReplyP95Seconds)}。不含未留下紀錄的「收到」回覆。`,
        ],
        [
          "查詢拿到答案",
          duration(data.answerSeconds),
          waitHint(
            data.answerSamples,
            data.answerSources,
            data.answerP95Seconds,
          ),
        ],
        ["已取消任務", `${data.cancelled} 件`, "期間內建立且目前已取消的任務"],
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
          <SectionHeader>使用摩擦</SectionHeader>
          <CardDescription role="status">
            {data
              ? `近 ${data.days} 天，範圍：${scope}（共 ${data.tasks} 件任務）`
              : error
                ? "尚未取得統計"
                : "讀取中…"}
            {data && loading && " 更新中…"}
          </CardDescription>
        </div>
        <Toolbar className="text-sm">
          <NativeSelect
            aria-label="期間"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </NativeSelect>
          <NativeSelect
            aria-label="群組"
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              setExcluded([]);
            }}
          >
            <option value="">全部群組</option>
            <option value="exclude">排除指定群組</option>
            {state.groups.map((g) => (
              <option key={g.id} value={`id:${g.id}`}>
                {g.name}
              </option>
            ))}
          </NativeSelect>
        </Toolbar>
      </CardHeader>
      <CardContent>
        {group === "exclude" && (
          <fieldset className="mb-4 min-w-0">
            <legend className="text-sm font-medium">排除哪些群組？</legend>
            <p className="text-xs text-muted-foreground">
              最多選 {maxExcludedGroups} 個群組。
            </p>
            <div className="flex flex-wrap items-center gap-x-4">
              {state.groups.map((item) => (
                <label
                  key={item.id}
                  className="flex min-h-11 min-w-0 items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={excluded.includes(item.id)}
                    disabled={
                      !excluded.includes(item.id) &&
                      excluded.length >= maxExcludedGroups
                    }
                    onCheckedChange={(checked) =>
                      setExcluded((ids) =>
                        checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span className="wrap-anywhere">{item.name}</span>
                </label>
              ))}
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!excluded.length}
                onClick={() => setExcluded([])}
              >
                清除
              </Button>
            </div>
          </fieldset>
        )}
        {error && (
          <InlineNotice as="p" tone="danger" role="alert">
            {error}
          </InlineNotice>
        )}
        {data && (
          <p className="mb-2 text-sm">
            等待時間以來源訊息為起點；找不到來源時，以建單時間為起點。
          </p>
        )}
        <DataList variant="bordered">
          {rows.map(([label, value, hint]) => (
            <ListRow
              key={label}
              className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="text-sm font-medium sm:w-40">{label}</span>
              <span className="text-sm tabular-nums sm:w-32">{value}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </ListRow>
          ))}
        </DataList>
      </CardContent>
    </Card>
  );
}
