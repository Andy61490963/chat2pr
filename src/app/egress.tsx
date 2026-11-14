import { useCallback, useEffect, useState } from "react";
import {
  validateDomains,
  type EgressSettings,
  type InstallReport,
  type InstallReview,
} from "../../shared/install-plan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/form-controls";
import { type Request, message } from "./shared";

/** 系統頁：安裝階段、系統套件與開發下載共用的下載來源白名單（#18）。 */
export function EgressCard({ request }: { request: Request }) {
  const [data, setData] = useState<EgressSettings | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = await request<EgressSettings>("/api/egress");
      setData(d);
      setText(d.domains.join("\n"));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);
  const lines = text.split(/\r?\n/);
  const checked = validateDomains(lines);
  const changed =
    !!data && checked.domains.join("\n") !== data.domains.join("\n");
  const save = async (reset = false) => {
    setBusy(true);
    setNotice("");
    try {
      const r = await request<{ warning: string | null }>(
        "/api/egress",
        "PUT",
        reset ? { reset: true } : { domains: lines },
      );
      setNotice(r.warning ?? "已保存並更新套件出口代理。");
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle>下載來源白名單</CardTitle>
        <CardDescription>
          安裝相依套件、安裝審查放行的系統套件，以及開發時下載套件，只能經代理連到這些網域（只限
          https）。開頭加點代表連同子網域，例如
          .nuget.org。主機、私有網段與清單外的網域一律拒絕。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            {notice}
          </p>
        )}
        {data && (
          <>
            <Textarea
              aria-label="下載來源白名單（每行一個網域）"
              rows={Math.min(16, Math.max(6, lines.length + 1))}
              className="font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {checked.errors.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-danger">
                {checked.errors.slice(0, 5).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={busy || !changed || checked.errors.length > 0}
                onClick={() => void save()}
              >
                儲存
              </Button>
              <Button
                variant="outline"
                disabled={busy || !data.custom}
                onClick={() => void save(true)}
              >
                還原預設
              </Button>
              <span className="text-xs text-muted-foreground">
                {data.custom ? "已自訂" : "使用預設清單"}，共{" "}
                {data.domains.length} 個（最多 {data.max}）。變更會寫入稽核。
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 安裝前審查的逐項結果：裝了什麼、為什麼、誰放行；被拒絕的照常列出原因。 */
export function InstallReviewList({ review }: { review: InstallReview }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p className="text-xs text-muted-foreground">審查：{review.reviewer}</p>
      <ul className="flex flex-col gap-1.5">
        {review.decisions.map((d) => (
          <li key={d.name} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={d.approved ? "good" : "danger"}>
                {d.approved ? "放行" : "拒絕"}
              </Badge>
              <span className="font-medium break-all">
                {d.name}
                {d.version ? ` ${d.version}` : ""}
              </span>
              <span className="text-xs text-muted-foreground break-all">
                {d.source}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              用途：{d.purpose}
            </span>
            <span className="text-xs text-muted-foreground">
              {d.decidedBy === "rules" ? "固定規則" : "審查模型"}：{d.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 單次執行的系統套件：使用的衍生映像與審查結果。 */
export function InstallReportView({ report }: { report: InstallReport }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 className="text-xs font-medium text-muted-foreground">系統套件</h3>
      <p className="text-sm break-all">
        {report.image
          ? `${report.reused ? "重用" : "建立"}專案衍生映像 ${report.image}${report.reused ? "，沒有重新下載" : ""}（基底 ${report.base}）`
          : report.error
            ? `${report.error}，本次使用原本的工作映像`
            : "安裝計畫全部被拒絕，本次使用原本的工作映像"}
      </p>
      <InstallReviewList review={report.review} />
    </section>
  );
}
