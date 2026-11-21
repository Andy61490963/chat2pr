import { useEffect, useState } from "react";
import type { Project } from "../../shared/types.js";
import {
  maxSshDescriptionLength,
  sshHostNamePattern,
  type SshExtractDraft,
  type SshHostView,
  type SshTestResult,
} from "../../shared/project-ssh.js";
import { sshProbeLabels } from "../../shared/status-glossary.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, Textarea } from "@/components/ui/form-controls";
import { ConfirmButton } from "./confirm";
import { useUnsaved } from "./unsaved";
import { message, type Request, type Run } from "./shared";
import { portError } from "./project-form";

const blank = {
  name: "",
  host: "",
  port: "22",
  username: "",
  auth: "password" as "password" | "key",
  password: "",
  privateKey: "",
  passphrase: "",
  note: "",
};
type Draft = typeof blank;

/** 專案詳情的「SSH 主機」：完全存取的任務可用 agentflow-ssh 登入。密碼與私鑰只寫入，不回顯。 */
export function ProjectSsh({
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
  const base = `/api/projects/${project.id}/ssh-hosts`;
  const [hosts, setHosts] = useState<SshHostView[] | null>(null);
  const [loadError, setLoadError] = useState("");
  // editing：null 不顯示表單；"new" 新增；其他是正在編輯的主機 id。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [formError, setFormError] = useState("");
  const [tests, setTests] = useState<Record<string, SshTestResult>>({});
  const [testing, setTesting] = useState("");
  const [description, setDescription] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [candidates, setCandidates] = useState<
    (SshExtractDraft & { index: number })[]
  >([]);
  const [reviewing, setReviewing] = useState<number | null>(null);
  useUnsaved(
    `project-ssh:${project.id}`,
    !!description.trim() ||
      candidates.length > 0 ||
      (editing !== null && JSON.stringify(draft) !== JSON.stringify(blank)),
  );

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<SshHostView[]>(base)
      .then((next) => active && setHosts(next))
      .catch((e) => active && setLoadError(message(e)));
    return () => {
      active = false;
    };
  }, [project.id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setFormError("");
  };
  const open = (host?: SshHostView) => {
    setReviewing(null);
    setEditing(host?.id ?? "new");
    setFormError("");
    setDraft(
      host
        ? {
            ...blank,
            name: host.name,
            host: host.host,
            port: String(host.port),
            username: host.username,
            auth: host.auth,
            note: host.note,
          }
        : blank,
    );
  };
  const close = () => {
    setReviewing(null);
    setEditing(null);
    setDraft(blank);
    setFormError("");
  };
  const extract = async () => {
    setExtracting(true);
    setExtractError("");
    try {
      const result = await request<{ hosts: SshExtractDraft[] }>(
        `${base}/extract`,
        "POST",
        { text: description.trim() },
      );
      setDescription("");
      setCandidates(result.hosts.map((host, index) => ({ ...host, index })));
      if (!result.hosts.length)
        setExtractError("請在描述中寫出你要登記的 SSH 主機。");
    } catch (e) {
      setExtractError(message(e));
    } finally {
      setExtracting(false);
    }
  };
  const review = (host: SshExtractDraft & { index: number }) => {
    open();
    setReviewing(host.index);
    setDraft({
      name: host.name ?? "",
      host: host.host ?? "",
      port: String(host.port),
      username: host.username ?? "",
      auth: host.privateKey ? "key" : "password",
      password: host.password ?? "",
      privateKey: host.privateKey ?? "",
      passphrase: host.passphrase ?? "",
      note: host.note ?? "",
    });
  };
  const discard = (index: number) => {
    setCandidates((current) => current.filter((host) => host.index !== index));
  };
  const save = async () => {
    const isNew = editing === "new";
    const problem = !sshHostNamePattern.test(draft.name.trim())
      ? "名稱只能用英數字與 . _ -，最多 40 字（Codex 用這個名稱登入）"
      : !draft.host.trim()
        ? "請填主機位址"
        : portError(draft.port) ||
          (!draft.username.trim()
            ? "請填帳號"
            : isNew && draft.auth === "password" && !draft.password
              ? "請填密碼"
              : isNew && draft.auth === "key" && !draft.privateKey.trim()
                ? "請貼上私鑰"
                : "");
    if (problem) return setFormError(problem);
    const body = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: Number(draft.port),
      username: draft.username.trim(),
      note: draft.note.trim(),
      ...(draft.auth === "key"
        ? draft.privateKey.trim()
          ? {
              privateKey: draft.privateKey,
              ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
            }
          : {}
        : draft.password
          ? { password: draft.password }
          : {}),
    };
    const ok = await run(async () => {
      const next = await request<SshHostView[]>(
        isNew ? base : `${base}/${editing}`,
        isNew ? "POST" : "PUT",
        body,
      );
      setHosts(next);
    }, `已儲存 SSH 主機 ${body.name}`);
    if (ok) {
      if (reviewing !== null) discard(reviewing);
      close();
    }
  };
  const test = async (host: SshHostView) => {
    setTesting(host.id);
    try {
      const result = await request<SshTestResult>(
        `${base}/${host.id}/test`,
        "POST",
      );
      setTests((t) => ({ ...t, [host.id]: result }));
      if (result.ok) setHosts(await request<SshHostView[]>(base));
    } catch (e) {
      setTests((t) => ({ ...t, [host.id]: { ok: false, detail: message(e) } }));
    } finally {
      setTesting("");
    }
  };

  const field = (
    key: "name" | "host" | "port" | "username" | "password" | "passphrase",
    label: string,
    options: { type?: string; placeholder?: string; className?: string } = {},
  ) => (
    <div className={`space-y-1.5 ${options.className ?? ""}`}>
      <Label htmlFor={`ssh-${key}`}>{label}</Label>
      <Input
        id={`ssh-${key}`}
        autoFocus={key === "name" && reviewing !== null}
        type={options.type ?? "text"}
        placeholder={options.placeholder}
        autoComplete={
          key === "password" || key === "passphrase" ? "new-password" : "off"
        }
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </div>
  );

  return (
    <section className="flex flex-col gap-2" aria-labelledby="ssh-hosts-title">
      <h3 id="ssh-hosts-title" className="text-sm font-medium">
        SSH 主機
      </h3>
      <p className="text-sm text-muted-foreground">
        開啟完全存取後，Codex 可用登記的帳號 SSH
        登入這些主機執行命令或複製檔案，就像你開著終端機。權限照登記的帳號，建議用只能讀的帳號。密碼與私鑰只寫入，不會再顯示，執行紀錄也會遮蔽。
      </p>
      {!project.full_access && (
        <p className="text-sm text-warn">
          這個專案沒有開啟完全存取，登記的主機不會交給任務。
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm text-danger">
          讀不到 SSH 主機：{loadError}
        </p>
      )}
      {hosts && hosts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {hosts.map((h) => (
            <li key={h.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{h.name}</span>
                <span className="break-all text-muted-foreground">
                  {h.username}@{h.host}:{h.port}
                </span>
                <Badge variant="secondary">
                  {h.auth === "key" ? "私鑰" : "密碼"}
                </Badge>
                <Badge variant={h.hostKey ? "good" : "warn"}>
                  {h.hostKey ? "已核對主機金鑰" : "還沒測試登入"}
                </Badge>
              </div>
              {h.note && <p className="mt-1 text-muted-foreground">{h.note}</p>}
              {tests[h.id] && (
                <p
                  role="status"
                  className={`mt-1 ${tests[h.id].ok ? "text-good" : "text-danger"}`}
                >
                  {tests[h.id].detail}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || testing === h.id}
                  onClick={() => void test(h)}
                >
                  {testing === h.id ? "登入中…" : "測試登入"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || reviewing !== null}
                  onClick={() => open(h)}
                >
                  編輯
                </Button>
                <ConfirmButton
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title={`刪除 SSH 主機 ${h.name}？`}
                  description="之後的任務就不能再登入這台主機；帳密會一起刪除。"
                  confirm="刪除"
                  onConfirm={() =>
                    run(async () => {
                      setHosts(
                        await request<SshHostView[]>(
                          `${base}/${h.id}`,
                          "DELETE",
                        ),
                      );
                    }, `已刪除 SSH 主機 ${h.name}`)
                  }
                >
                  刪除
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 rounded-lg border p-3">
        <Label htmlFor="ssh-describe">用白話描述主機</Label>
        <Textarea
          id="ssh-describe"
          rows={3}
          maxLength={maxSshDescriptionLength}
          spellCheck={false}
          autoComplete="off"
          disabled={extracting || candidates.length > 0}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="例如 U01 工控電腦 u01.example.test，帳號 reader，日誌在 C:/logs"
          aria-describedby="ssh-describe-help"
        />
        <p id="ssh-describe-help" className="text-xs text-muted-foreground">
          你可以貼上多台主機的資料，帳密與私鑰也會交給 AI
          判讀，原文只用於這次整理。
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={
            busy || extracting || candidates.length > 0 || !description.trim()
          }
          onClick={() => void extract()}
        >
          {extracting ? "AI 整理中…" : "交給 AI 整理"}
        </Button>
        {extractError && (
          <p role="alert" className="text-sm text-danger">
            {extractError}
          </p>
        )}
        {candidates.length > 0 && (
          <>
            <p role="status" className="text-sm font-medium">
              請逐台核對草稿，再儲存你要登記的主機。
            </p>
            <ul aria-label="SSH 主機草稿" className="space-y-2">
              {candidates.map((host) => {
                const status =
                  host.probe === null
                    ? "unmeasured"
                    : host.probe.reachable
                      ? "reachable"
                      : "unreachable";
                return (
                  <li
                    key={host.index}
                    className="space-y-1 rounded-lg border p-3 text-sm"
                  >
                    <p className="font-medium">{host.name || "未命名的主機"}</p>
                    <p className="break-all text-muted-foreground">
                      {host.host
                        ? `${host.username ? `${host.username}@` : ""}${host.host}:${host.port}`
                        : "請填主機位址"}
                    </p>
                    {host.note && (
                      <p className="text-muted-foreground">{host.note}</p>
                    )}
                    <p
                      className={
                        status === "reachable"
                          ? "text-good"
                          : status === "unreachable"
                            ? "text-danger"
                            : "text-muted-foreground"
                      }
                    >
                      {sshProbeLabels[status]}
                    </p>
                    {host.probe && (
                      <p className="text-muted-foreground">
                        {host.probe.detail}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || editing !== null}
                        onClick={() => review(host)}
                      >
                        核對草稿
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || reviewing === host.index}
                        onClick={() => discard(host.index)}
                      >
                        略過草稿
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {editing === null ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || hosts === null}
            onClick={() => open()}
          >
            新增 SSH 主機
          </Button>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-4">
            {field("name", "名稱", {
              placeholder: "例如 jet-u01",
              className: "sm:col-span-4",
            })}
            {field("host", "SSH 主機位址", {
              placeholder: "例如 10.3.7.31",
              className: "sm:col-span-3",
            })}
            {field("port", "SSH 連接埠", { type: "number" })}
            {field("username", "登入帳號", { className: "sm:col-span-4" })}
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">驗證方式</legend>
            <div className="flex gap-4 text-sm">
              {(["password", "key"] as const).map((a) => (
                <label key={a} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ssh-auth"
                    checked={draft.auth === a}
                    onChange={() => set("auth", a)}
                  />
                  {a === "password" ? "密碼" : "私鑰"}
                </label>
              ))}
            </div>
          </fieldset>
          {draft.auth === "password" ? (
            field("password", "登入密碼", {
              type: "password",
              placeholder: editing === "new" ? "" : "不改就留空",
            })
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-privateKey">私鑰</Label>
                <Textarea
                  id="ssh-privateKey"
                  rows={3}
                  placeholder={
                    editing === "new"
                      ? "-----BEGIN OPENSSH PRIVATE KEY-----"
                      : "不改就留空"
                  }
                  value={draft.privateKey}
                  onChange={(e) => set("privateKey", e.target.value)}
                />
              </div>
              {field("passphrase", "私鑰密碼片語（選填）", {
                type: "password",
              })}
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ssh-note">用途說明（選填，會告訴 Codex）</Label>
            <Textarea
              id="ssh-note"
              rows={2}
              placeholder="例如 U01 工控電腦，採集日誌在 C:/logs"
              value={draft.note}
              onChange={(e) => set("note", e.target.value)}
            />
          </div>
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {reviewing === null ? "儲存" : "確認並儲存"}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={close}>
              取消
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
