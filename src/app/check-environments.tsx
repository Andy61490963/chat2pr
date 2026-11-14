import { useCallback, useEffect, useState } from "react";
import type { CheckEnvironmentPolicy } from "../../shared/check-environment";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type Request, message } from "./shared";

type Settings = CheckEnvironmentPolicy & {
  defaults: CheckEnvironmentPolicy;
  limits: Record<keyof CheckEnvironmentPolicy, { min: number; max: number }>;
};

/** 系統頁：定期檢查環境閒置多久清除、最多保留幾個（#19）。 */
export function CheckEnvironmentCard({
  request,
  admin,
}: {
  request: Request;
  admin: boolean;
}) {
  const [data, setData] = useState<Settings | null>(null),
    [idle, setIdle] = useState(""),
    [max, setMax] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = await request<Settings>("/api/check-environments/settings");
      setData(d);
      setIdle(String(d.idleMinutes));
      setMax(String(d.max));
    } catch (e) {
      setNote(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    setBusy(true);
    try {
      await request("/api/settings/check-environments", "PUT", {
        idleMinutes: Number(idle),
        max: Number(max),
      });
      setNote("已儲存，超過新設定的環境會立即清除");
      await load();
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };
  const inRange = (v: string, r: { min: number; max: number }) =>
    Number.isInteger(Number(v)) && Number(v) >= r.min && Number(v) <= r.max;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle>定期檢查環境</CardTitle>
        <CardDescription>
          每個定期檢查在自己的檢查容器執行，網路只通到該檢查的目標。執行完先保留，下次直接重用；閒置超過設定時間，或檢查、資料庫連線變更時才清除。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {note && (
          <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            {note}
          </p>
        )}
        {data && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col gap-2 text-sm">
              <span>閒置多久清除（分鐘）</span>
              <Input
                type="number"
                className="w-28"
                min={data.limits.idleMinutes.min}
                max={data.limits.idleMinutes.max}
                value={idle}
                disabled={!admin}
                onChange={(e) => setIdle(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm">
              <span>最多保留幾個</span>
              <Input
                type="number"
                className="w-28"
                min={data.limits.max.min}
                max={data.limits.max.max}
                value={max}
                disabled={!admin}
                onChange={(e) => setMax(e.target.value)}
              />
            </label>
            {admin && (
              <Button
                disabled={
                  busy ||
                  !inRange(idle, data.limits.idleMinutes) ||
                  !inRange(max, data.limits.max) ||
                  (Number(idle) === data.idleMinutes &&
                    Number(max) === data.max)
                }
              >
                儲存
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              預設閒置 {data.defaults.idleMinutes} 分鐘、最多{" "}
              {data.defaults.max} 個；超過上限時先清最久沒用的。
            </span>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
