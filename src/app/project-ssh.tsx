import { useEffect, useState } from "react";
import type { Project } from "../../shared/types.js";
import {
  sshHostNamePattern,
  type SshHostView,
  type SshTestResult,
} from "../../shared/project-ssh.js";
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
  useUnsaved(
    `project-ssh:${project.id}`,
    editing !== null && JSON.stringify(draft) !== JSON.stringify(blank),
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
    setEditing(null);
    setDraft(blank);
    setFormError("");
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
    if (ok) close();
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
                  disabled={busy}
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
              placeholder="例如：住友 U01 的工控電腦，Windows，採集日誌在 C:/WeYuJet/logs"
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
              儲存
            </Button>
            <Button variant="outline" size="sm" onClick={close}>
              取消
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
