import { useCallback, useEffect, useMemo, useState } from "react";
import { HardDrive, RefreshCw, Trash2 } from "lucide-react";
import {
  diskRules,
  ruleLabels,
  type DiskItem,
  type DiskReport,
  type DiskRule,
  type DiskSettings,
} from "../../shared/docker-disk";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox, Switch } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type Request, ago, date, message } from "./shared";

const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(n / 1024 ** 2)} MB`;

const levels = {
  ok: { label: "空間足夠", variant: "good" },
  low: { label: "空間不足", variant: "warn" },
  critical: { label: "嚴重不足", variant: "danger" },
  unknown: { label: "讀不到可用空間", variant: "secondary" },
} as const;

const ruleHelp: Record<DiskRule, string> = {
  workspaces:
    "任務結束超過保留天數、沒有容器掛載的工作資料卷。執行中與保留期內的不動。",
  containers: "本系統建立、已經停止的工作容器。執行中的不動。",
  images:
    "本系統的舊工作映像與專案衍生映像，沒有專案設定使用、沒有容器在用，建立超過指定天數。:local、:latest 一律保留。",
  build_cache: "建置快取超過上限時，從最舊的清起，清到上限以內。",
};

type CleanupResult = {
  removed: string[];
  failed: { key: string; reason: string }[];
  skipped: string[];
  summary: string;
};

/** 系統頁：Docker 磁碟用量、空間提醒與清理規則。清理一律先列出項目，管理者確認後才刪。 */
export function DockerDiskCard({ request }: { request: Request }) {
  const [report, setReport] = useState<DiskReport | null>(null);
  const [draft, setDraft] = useState<DiskSettings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<DiskItem[] | null>(null);
  const [chosen, setChosen] = useState<Set<DiskRule>>(new Set());
  const [cleaning, setCleaning] = useState(false);

  const dirty = useMemo(
    () =>
      !!report &&
      !!draft &&
      JSON.stringify(report.settings) !== JSON.stringify(draft),
    [report, draft],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await request<DiskReport>("/api/system/disk");
      setReport(r);
      setError("");
      return r;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => {
    void load().then((r) => r && setDraft(r.settings));
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await request<DiskSettings>(
        "/api/system/disk/settings",
        "PUT",
        draft,
      );
      setDraft(saved);
      setNotice("設定已儲存");
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  // 預覽前重新盤點，列出的就是這一刻會刪除的項目。
  const openPreview = async () => {
    setNotice("");
    const r = await load();
    if (!r) return;
    setChosen(new Set(r.candidates.map((c) => c.rule!).filter(Boolean)));
    setPreview(r.candidates);
  };

  const cleanup = async () => {
    if (!preview) return;
    const keys = preview
      .filter((c) => c.rule && chosen.has(c.rule))
      .map((c) => c.key);
    if (!keys.length) return;
    setCleaning(true);
    try {
      const result = await request<CleanupResult>(
        "/api/system/disk/cleanup",
        "POST",
        { keys },
      );
      setPreview(null);
      setNotice(`清理完成：${result.summary}`);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setCleaning(false);
    }
  };

  const setRule = <R extends DiskRule>(
    rule: R,
    patch: Partial<DiskSettings["rules"][R]>,
  ) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            rules: { ...d.rules, [rule]: { ...d.rules[rule], ...patch } },
          }
        : d,
    );

  const level = report ? levels[report.level] : null;
  const anyRule = draft ? diskRules.some((r) => draft.rules[r].enabled) : false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="size-4" /> Docker 磁碟
            {level && <Badge variant={level.variant}>{level.label}</Badge>}
          </CardTitle>
          <CardDescription>
            {report
              ? `最後盤點 ${ago(report.checkedAt)}；數字與 docker system df 相同算法`
              : "盤點中…（映像與資料卷多時需要一點時間）"}
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={cn(loading && "animate-spin")} /> 重新盤點
          </Button>
          <Button
            size="sm"
            disabled={loading || !report}
            onClick={() => void openPreview()}
          >
            <Trash2 /> 立即清理
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg bg-good-soft px-3 py-2 text-sm text-good">
            {notice}
          </p>
        )}
        {report?.paused && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            可用空間低於 {report.settings.pause_percent}%，已暫停派新工作。
            排隊中的任務會留在佇列，空間回升後自動執行；清理後按「重新盤點」確認。
          </p>
        )}
        {report?.level === "critical" && !report.paused && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            可用空間低於 {report.settings.pause_percent}
            %。「空間不足時暫停派工」沒有開啟，
            新工作仍會執行，可能因為磁碟滿而在安裝或建置時失敗。
          </p>
        )}
        {report && (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                可用空間（提醒門檻 {report.settings.warn_percent}%）
              </h3>
              {report.spaces.length ? (
                <ul className="flex flex-col gap-2">
                  {report.spaces.map((s) => {
                    const free = s.totalBytes ? s.freeBytes / s.totalBytes : 0;
                    return (
                      <li key={s.label} className="flex flex-col gap-1 text-sm">
                        <span className="flex justify-between gap-3">
                          <span className="truncate">{s.label}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            可用 {bytes(s.freeBytes)}／{bytes(s.totalBytes)}（
                            {(free * 100).toFixed(1)}%）
                          </span>
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              free * 100 < report.settings.pause_percent
                                ? "bg-danger"
                                : free * 100 < report.settings.warn_percent
                                  ? "bg-warn"
                                  : "bg-good",
                            )}
                            style={{ width: `${(1 - free) * 100}%` }}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  讀不到磁碟可用空間，暫時無法提醒。
                </p>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                用量
              </h3>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left font-medium">類型</th>
                      <th className="px-3 py-2 text-right font-medium">數量</th>
                      <th className="px-3 py-2 text-right font-medium">在用</th>
                      <th className="px-3 py-2 text-right font-medium">大小</th>
                      <th className="px-3 py-2 text-right font-medium">
                        可回收
                      </th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {report.usage.map((u) => (
                      <tr key={u.kind} className="border-b last:border-0">
                        <td className="px-3 py-2">{u.label}</td>
                        <td className="px-3 py-2 text-right">{u.total}</td>
                        <td className="px-3 py-2 text-right">{u.active}</td>
                        <td className="px-3 py-2 text-right">
                          {bytes(u.size)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {bytes(u.reclaimable)}
                          {u.size > 0 &&
                            `（${Math.round((u.reclaimable / u.size) * 100)}%）`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                「可回收」是 Docker
                的估算，包含正式資料庫等不會刪的未掛載資料卷；
                實際會刪的項目以「立即清理」列出的為準。
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                歸屬
              </h3>
              <ul className="flex flex-wrap gap-2">
                {report.owners.map((o) => (
                  <li
                    key={o.owner}
                    className="rounded-md border px-2 py-1 text-xs tabular-nums"
                  >
                    {o.label} · {o.count} 個 · {bytes(o.size)}
                  </li>
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-1 text-sm">
              <p>
                下次自動清理：
                {report.nextCleanupAt
                  ? date(report.nextCleanupAt)
                  : "沒有開啟任何自動清理"}
              </p>
              {report.lastCleanup && (
                <p className="text-xs text-muted-foreground">
                  最近一次（{date(report.lastCleanup.at)}）：
                  {report.lastCleanup.detail}
                </p>
              )}
            </section>
          </>
        )}
        {draft && (
          <section className="flex flex-col gap-3 rounded-lg border p-3">
            <h3 className="text-sm font-medium">提醒與清理規則</h3>
            <p className="text-xs text-muted-foreground">
              清理規則預設全部關閉；開啟後每天自動執行一次並寫進活動紀錄。
              正式資料庫、備份、原始碼與套件快取資料卷，以及無法確認歸屬的資源，任何規則都不會刪。
            </p>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              可用空間低於
              <Input
                type="number"
                className="h-8 w-20"
                min={1}
                max={50}
                value={draft.warn_percent}
                onChange={(e) =>
                  setDraft({ ...draft, warn_percent: Number(e.target.value) })
                }
              />
              % 時私訊管理者
            </label>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <Switch
                checked={draft.pause_enabled}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, pause_enabled: v })
                }
              />
              低於
              <Input
                type="number"
                className="h-8 w-20"
                min={0.5}
                max={50}
                step={0.5}
                value={draft.pause_percent}
                onChange={(e) =>
                  setDraft({ ...draft, pause_percent: Number(e.target.value) })
                }
              />
              % 時暫停派新工作（關閉時只通知）
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Switch
                className="mt-0.5"
                checked={draft.daily_cleanup}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, daily_cleanup: v })
                }
              />
              <span className="flex flex-col">
                既有每日清理
                <span className="text-xs text-muted-foreground">
                  上線前就有的行為：刪除超過 14 天、沒有專案或容器在用的
                  line-agentflow-app／worker 舊標籤，清除懸空映像與 7
                  天沒用的建置快取。不刪資料卷。
                </span>
              </span>
            </label>
            <ul className="flex flex-col gap-3">
              {diskRules.map((rule) => {
                const r = draft.rules[rule] as {
                  enabled: boolean;
                  days?: number;
                  limit_gb?: number;
                };
                return (
                  <li key={rule} className="flex items-start gap-2 text-sm">
                    <Switch
                      className="mt-0.5"
                      checked={r.enabled}
                      onCheckedChange={(v) => setRule(rule, { enabled: v })}
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        {ruleLabels[rule]}
                        {r.days !== undefined && (
                          <>
                            ，保留
                            <Input
                              type="number"
                              className="h-7 w-16"
                              min={1}
                              value={r.days}
                              onChange={(e) =>
                                setRule(rule, {
                                  days: Number(e.target.value),
                                } as never)
                              }
                            />
                            天
                          </>
                        )}
                        {r.limit_gb !== undefined && (
                          <>
                            ，上限
                            <Input
                              type="number"
                              className="h-7 w-20"
                              min={5}
                              value={r.limit_gb}
                              onChange={(e) =>
                                setRule(rule, {
                                  limit_gb: Number(e.target.value),
                                } as never)
                              }
                            />
                            GB
                          </>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {ruleHelp[rule]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                儲存設定
              </Button>
              {!anyRule && (
                <span className="text-xs text-muted-foreground">
                  目前只盤點與提醒，不會自動刪除。
                </span>
              )}
            </div>
          </section>
        )}
        {report && report.protected.length > 0 && (
          <details className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer">
              只列出、不會刪除的項目（{report.protected.length}）
            </summary>
            <ul className="mt-2 divide-y">
              {report.protected.map((p) => (
                <li key={p.key} className="flex items-center gap-3 py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <code className="truncate text-xs">{p.name}</code>
                    <span className="truncate text-xs text-muted-foreground">
                      {p.protected} · {p.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {bytes(p.size)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>確認要清理的項目</DialogTitle>
            <DialogDescription>
              下面是依各規則目前條件會刪除的項目（不論規則是否開啟）。勾選要清理的類別後按刪除；刪除後無法復原，結果會寫進活動紀錄。
            </DialogDescription>
          </DialogHeader>
          {preview && !preview.length && (
            <p className="text-sm text-muted-foreground">
              目前沒有可清理的項目。
            </p>
          )}
          {preview &&
            diskRules.map((rule) => {
              const group = preview.filter((c) => c.rule === rule);
              if (!group.length) return null;
              return (
                <section key={rule} className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={chosen.has(rule)}
                      onCheckedChange={(v) =>
                        setChosen((s) => {
                          const next = new Set(s);
                          if (v === true) next.add(rule);
                          else next.delete(rule);
                          return next;
                        })
                      }
                    />
                    {ruleLabels[rule]}（{group.length} 項）
                  </label>
                  <ul className="ml-6 divide-y rounded-md border text-xs">
                    {group.map((c) => (
                      <li key={c.key} className="flex gap-3 px-2 py-1.5">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <code className="truncate">{c.name}</code>
                          <span className="truncate text-muted-foreground">
                            {c.detail}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {bytes(c.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">先不要</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={
                cleaning || !preview?.some((c) => c.rule && chosen.has(c.rule))
              }
              onClick={() => void cleanup()}
            >
              刪除{" "}
              {preview?.filter((c) => c.rule && chosen.has(c.rule)).length ?? 0}{" "}
              項
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
