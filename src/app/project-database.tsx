import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types.js";
import {
  objectLabels,
  type ConnectionExtractResult,
  type ConnectionTestResult,
  type ProjectDatabaseView,
} from "../../shared/project-database.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Label, Textarea } from "@/components/ui/form-controls";
import { ConfirmButton } from "./confirm";
import { useUnsaved } from "./unsaved";
import { date, message, type Request, type Run } from "./shared";
import { portError } from "./project-form";

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
  onInitialFocus,
}: {
  project: Project;
  busy: boolean;
  request: Request;
  run: Run;
  onInitialFocus?: () => void;
}) {
  const base = `/api/projects/${project.id}/database`;
  const [view, setView] = useState<ProjectDatabaseView | null>(null);
  // 專案頁只有管理者看得到，讀取失敗是服務或網路問題：保留區塊並說明原因，不再整塊隱藏。
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saved, setSaved] = useState(JSON.stringify(blank));
  const [tested, setTested] = useState<ConnectionTestResult | null>(null);
  // 測試連線與擷取結構的失敗原因留在區塊內，直到下一次操作或修改草稿；toast 12 秒就消失。
  const [actionError, setActionError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof Draft, string>>
  >({});
  const [notice, setNotice] = useState("");
  // 用白話描述連線：交給 AI 整理後填進下面的欄位，不會自動儲存；原文整理完就清掉。
  const [describe, setDescribe] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ConnectionExtractResult | null>(
    null,
  );
  const [extractError, setExtractError] = useState("");
  const extract = async () => {
    setExtracting(true);
    setExtractError("");
    try {
      const r = await request<ConnectionExtractResult>(
        `${base}/extract`,
        "POST",
        {
          text: describe,
        },
      );
      const c = r.connection;
      setDraft((d) => ({
        ...d,
        ...(c.host ? { host: c.host } : {}),
        ...(c.port ? { port: String(c.port) } : {}),
        ...(c.database ? { database: c.database } : {}),
        ...(c.username ? { username: c.username } : {}),
        ...(c.password ? { password: c.password } : {}),
        ...(c.encrypt !== null ? { encrypt: c.encrypt } : {}),
        ...(c.trustServerCertificate !== null
          ? { trustServerCertificate: c.trustServerCertificate }
          : {}),
        ...(c.ssh
          ? {
              useSsh: true,
              sshHost: c.ssh.host,
              sshPort: String(c.ssh.port ?? 22),
              ...(c.ssh.username ? { sshUsername: c.ssh.username } : {}),
              ...(c.ssh.password ? { sshPassword: c.ssh.password } : {}),
            }
          : {}),
      }));
      setExtracted(r);
      setDescribe("");
    } catch (e) {
      setExtractError(message(e));
    } finally {
      setExtracting(false);
    }
  };
  const loaded = view !== null;
  const firstField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!loaded || !onInitialFocus) return;
    firstField.current?.focus();
    onInitialFocus();
  }, [loaded, onInitialFocus]);
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
    setLoadError("");
    request<ProjectDatabaseView>(base)
      .then((next) => active && apply(next))
      .catch((e) => active && setLoadError(message(e)));
    return () => {
      active = false;
    };
  }, [project.id, reload]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setActionError("");
    setFieldErrors((errors) => {
      if (!errors[key]) return errors;
      const { [key]: _, ...rest } = errors;
      return rest;
    });
  };
  const field = (
    key: keyof Draft,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      className?: string;
      inputMode?: "numeric";
    } = {},
  ) => (
    <div className={`space-y-1.5 ${options.className ?? ""}`}>
      <Label htmlFor={`db-${key}`}>{label}</Label>
      <Input
        id={`db-${key}`}
        type={options.type ?? "text"}
        inputMode={options.inputMode}
        autoComplete={options.type === "password" ? "new-password" : "off"}
        spellCheck={false}
        value={String(draft[key])}
        placeholder={options.placeholder}
        aria-invalid={fieldErrors[key] ? true : undefined}
        aria-describedby={fieldErrors[key] ? `db-${key}-error` : undefined}
        onChange={(e) => set(key, e.target.value as never)}
      />
      {fieldErrors[key] && (
        <p id={`db-${key}-error`} className="text-xs text-danger">
          {fieldErrors[key]}
        </p>
      )}
    </div>
  );
  const connection = view?.connection ?? null;
  const snapshot = view?.snapshot ?? null;
  const keep = "已儲存；留空代表不變更";

  const save = () => {
    // 連接埠在送出前先檢查；空值用 Number() 會變成 0，伺服器只能回籠統的格式錯誤。
    const errors: Partial<Record<keyof Draft, string>> = {};
    const port = portError(draft.port);
    if (port) errors.port = port;
    const sshPort = draft.useSsh ? portError(draft.sshPort, "SSH 連接埠") : "";
    if (sshPort) errors.sshPort = sshPort;
    setFieldErrors(errors);
    if (port || sshPort) {
      document.getElementById(port ? "db-port" : "db-sshPort")?.focus();
      return;
    }
    void run(async () => {
      setTested(null);
      apply(
        await keepError("儲存失敗", () =>
          request<ProjectDatabaseView>(base, "PUT", {
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
        ),
      );
      setNotice("連線已儲存。接著按「測試連線」確認連得上。");
    }, "資料庫連線已儲存");
  };
  // 失敗時把原因留在區塊內，再丟出讓 run 照常顯示錯誤 toast，維持全站一致。
  const keepError = async <T,>(label: string, fn: () => Promise<T>) => {
    setActionError("");
    try {
      return await fn();
    } catch (e) {
      setActionError(`${label}：${message(e)}`);
      throw e;
    }
  };
  const test = () =>
    void run(async () => {
      setNotice("");
      setTested(null);
      setTested(
        await keepError("連線測試失敗", () =>
          request<ConnectionTestResult>(`${base}/test`, "POST"),
        ),
      );
    }, "連線測試成功");
  const capture = () =>
    void run(async () => {
      setNotice("");
      const result = await keepError("擷取結構失敗", () =>
        request<ProjectDatabaseView & { changed: boolean; queued: boolean }>(
          `${base}/snapshot`,
          "POST",
        ),
      );
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

      {loadError ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <p className="break-words">讀取資料庫連線設定失敗：{loadError}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReload((v) => v + 1)}
          >
            重新讀取
          </Button>
        </div>
      ) : (
        !loaded && (
          <p role="status" className="text-sm text-muted-foreground">
            正在讀取資料庫連線設定…
          </p>
        )
      )}

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

      {/* 讀取完成前整個表單停用，避免在空白草稿上按儲存，蓋掉已登記的連線。 */}
      <fieldset disabled={!loaded} className="min-w-0 space-y-4">
        <div className="space-y-2 rounded-lg border p-3">
          <Label htmlFor="db-describe">用白話描述連線</Label>
          <Textarea
            ref={firstField}
            id="db-describe"
            rows={3}
            value={describe}
            spellCheck={false}
            placeholder="例如：MES 測試庫在 100.85.185.123，port 1433，資料庫 MES_TEST，帳號 mes_reader 密碼 ……；廠內看板在 http://10.3.1.7:8096，要先連公司 VPN"
            onChange={(e) => setDescribe(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            可以包含帳號密碼。AI
            整理後填進下面的欄位，並從這台伺服器實測提到的位址；原文不保存，核對後再按「儲存連線」。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || extracting || !describe.trim()}
            onClick={() => void extract()}
          >
            {extracting ? "AI 整理中…" : "交給 AI 整理"}
          </Button>
          {extractError && (
            <p role="alert" className="text-sm text-danger">
              {extractError}
            </p>
          )}
          {extracted && (
            <div role="status" className="space-y-2 text-sm">
              <p className="font-medium">已填入下面的欄位，請核對後儲存。</p>
              {extracted.endpoints.length > 0 && (
                <ul className="space-y-1">
                  {extracted.endpoints.map((e) => (
                    <li
                      key={`${e.host}:${e.port}`}
                      className={e.reachable ? "text-good" : "text-danger"}
                    >
                      {e.reachable ? "✓" : "✕"} {e.purpose}：{e.host}:{e.port}，
                      {e.detail}
                    </li>
                  ))}
                </ul>
              )}
              {(extracted.vpn.needed ||
                extracted.endpoints.some((e) => !e.reachable)) && (
                <p className="rounded bg-warn-soft px-3 py-2 text-warn">
                  {extracted.vpn.note || "有位址連不到。"}
                  請讓這台伺服器本身連上 VPN 或 Tailscale subnet router；VPN
                  帳密不用給 chat2pr，設定一次後任務就連得到。
                </p>
              )}
              {extracted.notes.map((n) => (
                <p key={n} className="text-muted-foreground">
                  {n}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {field("host", "主機", {
            placeholder: "db.example.com 或 IP",
            className: "sm:col-span-3",
          })}
          {field("port", "連接埠", { type: "number", inputMode: "numeric" })}
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
              {field("sshPort", "連接埠", {
                type: "number",
                inputMode: "numeric",
              })}
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
                  setActionError("");
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
                  setActionError("");
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
      </fieldset>

      {actionError && (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {actionError}
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
