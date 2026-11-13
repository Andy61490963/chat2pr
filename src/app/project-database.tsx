import { useEffect, useState } from "react";
import type { Project } from "../../shared/types.js";
import {
  objectLabels,
  type ConnectionTestResult,
  type ProjectDatabaseView,
} from "../../shared/project-database.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import { ConfirmButton } from "./confirm";
import { useUnsaved } from "./unsaved";
import { date, type Request, type Run } from "./shared";

const blank = {
  host: "",
  port: "1433",
  database: "",
  username: "",
  password: "",
  encrypt: true,
  trustServerCertificate: true,
  referenceTables: "",
  useSsh: false,
  sshHost: "",
  sshPort: "22",
  sshUsername: "",
  sshPrivateKey: "",
  sshPassphrase: "",
  sshPassword: "",
};
type Draft = typeof blank;

const fromView = (view: ProjectDatabaseView | null): Draft => {
  const c = view?.connection;
  if (!c) return blank;
  return {
    ...blank,
    host: c.host,
    port: String(c.port),
    database: c.database,
    username: c.username,
    encrypt: c.encrypt,
    trustServerCertificate: c.trustServerCertificate,
    referenceTables: c.referenceTables.join("\n"),
    useSsh: !!c.ssh,
    sshHost: c.ssh?.host ?? "",
    sshPort: String(c.ssh?.port ?? 22),
    sshUsername: c.ssh?.username ?? "",
  };
};

/** 專案詳情的「資料庫連線」：登記連線、測試、擷取結構快照。機密只寫入，不回顯。 */
export function ProjectDatabase({
  project,
  busy,
  request,
  run,
}: {
  project: Project;
  busy: boolean;
  request: Request;
  run: Run;
}) {
  const base = `/api/projects/${project.id}/database`;
  const [view, setView] = useState<ProjectDatabaseView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saved, setSaved] = useState(JSON.stringify(blank));
  const [tested, setTested] = useState<ConnectionTestResult | null>(null);
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(draft) !== saved;
  useUnsaved(`project-database:${project.id}`, dirty);

  const apply = (next: ProjectDatabaseView) => {
    setView(next);
    const value = fromView(next);
    setDraft(value);
    setSaved(JSON.stringify(value));
  };
  useEffect(() => {
    let active = true;
    request<ProjectDatabaseView>(base)
      .then((next) => active && apply(next))
      // 只有管理者能看連線設定；其他成員不顯示這個區塊。
      .catch(() => active && setHidden(true));
    return () => {
      active = false;
    };
  }, [project.id]);
  if (hidden) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const field = (
    key: keyof Draft,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      className?: string;
    } = {},
  ) => (
    <div className={`space-y-1.5 ${options.className ?? ""}`}>
      <Label htmlFor={`db-${key}`}>{label}</Label>
      <Input
        id={`db-${key}`}
        type={options.type ?? "text"}
        autoComplete={options.type === "password" ? "new-password" : "off"}
        spellCheck={false}
        value={String(draft[key])}
        placeholder={options.placeholder}
        onChange={(e) => set(key, e.target.value as never)}
      />
    </div>
  );
  const connection = view?.connection ?? null;
  const snapshot = view?.snapshot ?? null;
  const keep = "已儲存；留空代表不變更";

  const save = () =>
    void run(async () => {
      setTested(null);
      apply(
        await request<ProjectDatabaseView>(base, "PUT", {
          engine: "sqlserver",
          host: draft.host.trim(),
          port: Number(draft.port),
          database: draft.database.trim(),
          username: draft.username.trim(),
          ...(draft.password ? { password: draft.password } : {}),
          encrypt: draft.encrypt,
          trustServerCertificate: draft.trustServerCertificate,
          referenceTables: draft.referenceTables
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          ssh: draft.useSsh
            ? {
                host: draft.sshHost.trim(),
                port: Number(draft.sshPort),
                username: draft.sshUsername.trim(),
                ...(draft.sshPrivateKey
                  ? {
                      privateKey: draft.sshPrivateKey,
                      ...(draft.sshPassphrase
                        ? { passphrase: draft.sshPassphrase }
                        : {}),
                    }
                  : draft.sshPassword
                    ? { password: draft.sshPassword }
                    : {}),
              }
            : null,
        }),
      );
      setNotice("連線已儲存。接著按「測試連線」確認連得上。");
    }, "資料庫連線已儲存");
  const test = () =>
    void run(async () => {
      setNotice("");
      setTested(null);
      setTested(await request<ConnectionTestResult>(`${base}/test`, "POST"));
    });
  const capture = () =>
    void run(async () => {
      const result = await request<
        ProjectDatabaseView & { changed: boolean; queued: boolean }
      >(`${base}/snapshot`, "POST");
      apply(result);
      setNotice(
        !result.changed
          ? "結構和上次相同，沒有變化。"
          : result.queued
            ? "已擷取結構，並排程重新驗證環境；通過後才會恢復派工。"
            : project.setup_mode === "auto"
              ? "已擷取結構。請按上方的「AI 自動設定並驗證」重新驗證環境。"
              : "已擷取結構；手動指令可從 /agentflow/env/database 讀取快照。",
      );
    }, "資料庫結構已擷取");

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-label="資料庫連線"
    >
      <div>
        <h3 className="font-medium">資料庫連線</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          選填。登記後由主機擷取資料庫的結構（不含資料），AI
          用它在隔離容器裡建立測試資料庫。沒有登記時，AI
          會從程式碼推測結構自行模擬，不會停下來問你。
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          密碼與私鑰只寫入，儲存後不會再顯示，也不會交給 AI
          或工作容器。建議使用只有結構讀取權限的帳號。
        </p>
      </div>

      {snapshot ? (
        <div className="space-y-2 rounded bg-muted p-3 text-sm" role="status">
          <p className="font-medium">
            結構快照第 {snapshot.version} 版 · 擷取於{" "}
            {date(snapshot.capturedAt)}
          </p>
          <p className="text-muted-foreground">
            {Object.entries(objectLabels)
              .filter(([key]) => snapshot.objects[key] > 0)
              .map(([key, label]) => `${label} ${snapshot.objects[key]}`)
              .join("、") || "沒有任何物件"}
            {snapshot.referenceRows > 0 &&
              ` · 參考資料 ${snapshot.referenceRows} 列`}
          </p>
          {snapshot.warnings.map((warning) => (
            <p key={warning} className="text-warn">
              {warning}
            </p>
          ))}
        </div>
      ) : (
        view && (
          <p className="rounded bg-muted p-3 text-sm" role="status">
            還沒有結構快照。
            {connection
              ? "連線測試成功後，按「擷取結構」。"
              : "先填寫下面的連線並儲存。"}
          </p>
        )
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        {field("host", "主機", {
          placeholder: "db.example.com 或 IP",
          className: "sm:col-span-3",
        })}
        {field("port", "連接埠", { type: "number" })}
        {field("database", "資料庫名稱", { className: "sm:col-span-2" })}
        {field("username", "帳號", { className: "sm:col-span-2" })}
        {field("password", "密碼", {
          type: "password",
          placeholder: connection ? keep : "",
          className: "sm:col-span-4",
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        目前支援 SQL Server。連線由主機發出，所以主機要連得到這台資料庫。
      </p>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.encrypt}
            onCheckedChange={(v) => set("encrypt", v === true)}
          />
          加密連線
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.trustServerCertificate}
            onCheckedChange={(v) => set("trustServerCertificate", v === true)}
          />
          信任伺服器憑證（自簽憑證時勾選）
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.useSsh}
            onCheckedChange={(v) => set("useSsh", v === true)}
          />
          經 SSH 跳板連線
        </label>
      </div>

      {draft.useSsh && (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            主機無法直接連到資料庫時使用：先登入跳板，再由跳板連到上面的資料庫主機與連接埠。私鑰與密碼擇一。
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            {field("sshHost", "跳板主機", { className: "sm:col-span-3" })}
            {field("sshPort", "連接埠", { type: "number" })}
            {field("sshUsername", "SSH 帳號", { className: "sm:col-span-4" })}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="db-sshPrivateKey">私鑰</Label>
            <Textarea
              id="db-sshPrivateKey"
              rows={3}
              spellCheck={false}
              className="font-mono text-xs"
              value={draft.sshPrivateKey}
              placeholder={
                connection?.ssh?.auth === "key"
                  ? keep
                  : "貼上 OpenSSH 或 PEM 格式的私鑰全文"
              }
              onChange={(e) => set("sshPrivateKey", e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("sshPassphrase", "私鑰的密碼片語（沒有就留空）", {
              type: "password",
            })}
            {field("sshPassword", "或：SSH 密碼", {
              type: "password",
              placeholder: connection?.ssh?.auth === "password" ? keep : "",
            })}
          </div>
          {connection?.ssh?.hostKey && (
            <p className="break-all text-xs text-muted-foreground">
              已記住跳板的主機金鑰：{connection.ssh.hostKey}
              。之後不同就會拒絕連線。
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="db-referenceTables">參考資料表（選填）</Label>
        <Textarea
          id="db-referenceTables"
          rows={2}
          spellCheck={false}
          value={draft.referenceTables}
          placeholder={"每行一個，例如\ndbo.StatusCode"}
          onChange={(e) => set("referenceTables", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          只有列在這裡的資料表會連同資料一起擷取，每張最多 500
          列。適合狀態代碼這類不含個資的對照表；留空就完全不讀取資料。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !dirty} onClick={save}>
          儲存連線
        </Button>
        <Button
          variant="outline"
          disabled={busy || dirty || !connection}
          onClick={test}
        >
          測試連線
        </Button>
        <Button
          variant="outline"
          disabled={busy || dirty || !connection}
          onClick={capture}
        >
          {snapshot ? "重新擷取結構" : "擷取結構"}
        </Button>
        {connection && (
          <ConfirmButton
            variant="ghost"
            disabled={busy}
            title="刪除資料庫連線？"
            description="保存的密碼與私鑰會一併刪除。已擷取的結構快照會保留，AI 仍可使用。"
            confirm="刪除連線"
            onConfirm={() =>
              run(async () => {
                setTested(null);
                apply(await request<ProjectDatabaseView>(base, "DELETE"));
                setNotice("連線已刪除。");
              }, "資料庫連線已刪除")
            }
          >
            刪除連線
          </ConfirmButton>
        )}
        {snapshot && (
          <ConfirmButton
            variant="ghost"
            disabled={busy}
            title="刪除結構快照？"
            description="刪除後 AI 會改從程式碼推測資料庫結構。AI 自動設定的專案需要重新驗證環境才會恢復派工。"
            confirm="刪除快照"
            onConfirm={() =>
              run(async () => {
                const result = await request<
                  ProjectDatabaseView & { queued: boolean }
                >(`${base}/snapshot`, "DELETE");
                apply(result);
                setNotice(
                  result.queued
                    ? "快照已刪除，並排程重新驗證環境。"
                    : "快照已刪除。",
                );
              }, "結構快照已刪除")
            }
          >
            刪除快照
          </ConfirmButton>
        )}
      </div>
      {dirty && connection && (
        <p className="text-xs text-muted-foreground">
          有尚未儲存的修改；儲存後才能測試或擷取。
        </p>
      )}

      {tested && (
        <div className="space-y-1 text-sm" role="status">
          <p>
            連線成功：{tested.server}，看得到 {tested.tables} 個資料表。
          </p>
          {!tested.canViewDefinition && (
            <p className="text-warn">
              這個帳號沒有 VIEW DEFINITION
              權限，檢視、預存程序與函式的內容會擷取不到。
            </p>
          )}
          {tested.canWrite && (
            <p className="text-warn">
              這個帳號有寫入權限。系統只會讀取結構，但建議改用唯讀帳號。
            </p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
