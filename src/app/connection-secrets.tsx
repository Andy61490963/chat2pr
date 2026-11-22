import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  connectionSecretFields,
  connectionSecretLabels,
  parseConnectionSecrets,
  removableConnectionSecret,
  secretReauthMessage,
  secretReauthTarget,
  type ConnectionSecretField,
  type ConnectionSecretStatus,
} from "../../shared/connection-secrets.js";
import { describeConnectionSecretChanges } from "../../shared/settings-diff.js";
import { connectionSecretStatusLabels } from "../../shared/status-glossary.js";
import { ConfirmButton } from "./confirm";
import { date, message, type Request } from "./shared";

type Props = { request: Request; refresh: () => Promise<boolean> };

export function ConnectionSecrets({
  status,
  ...actions
}: Props & { status: ConnectionSecretStatus | undefined }) {
  if (!status)
    return (
      <p role="status">
        無法顯示連線金鑰狀態，因為服務未提供資料。請重新整理或檢查服務版本。
      </p>
    );
  return (
    <Card className="col-span-full min-w-0" role="region" aria-labelledby="connection-secrets-title">
      <CardHeader>
        <h2 id="connection-secrets-title" className="font-semibold">連線金鑰</h2>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {connectionSecretFields.map((field) => (
            <ConnectionSecretRow
              key={field}
              field={field}
              status={status[field]}
              {...actions}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ConnectionSecretRow({
  field,
  status,
  request,
  refresh,
}: Props & {
  field: ConnectionSecretField;
  status: ConnectionSecretStatus[ConnectionSecretField];
}) {
  const label = connectionSecretLabels[field];
  const inputId = `connection-secret-${field}`;
  const [value, setValue] = useState("");
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const mustSignIn = error === secretReauthMessage;

  async function save() {
    setError("");
    setSaved(false);
    const parsed = parseConnectionSecrets({ [field]: remove ? null : value });
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await request("/api/secrets", "PUT", parsed.patch);
      setValue("");
      setRemove(false);
      setSaved(true);
      await refresh();
    } catch (failure) {
      const detail = message(failure);
      if (detail === secretReauthMessage) {
        setValue("");
        setRemove(false);
      }
      setError(detail);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="grid min-w-0 gap-2 py-4 first:pt-0 last:pb-0">
      <label htmlFor={inputId} className="font-medium">
        {label}
      </label>
      <div
        id={`${inputId}-status`}
        className="flex flex-wrap gap-x-3 text-sm text-muted-foreground"
      >
        <span>
          {
            connectionSecretStatusLabels[
              status.configured ? "configured" : "unconfigured"
            ]
          }
        </span>
        <span>
          最後更新：
          {status.updatedAt
            ? date(status.updatedAt)
            : connectionSecretStatusLabels.unknownUpdatedAt}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          maxLength={4096}
          aria-describedby={`${inputId}-status${error ? ` ${inputId}-error` : ""}`}
          aria-invalid={(!!error && !mustSignIn) || undefined}
          className="min-h-11 min-w-0 flex-1 basis-44"
          value={value}
          disabled={busy || remove || mustSignIn}
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
            setSaved(false);
          }}
        />
        {removableConnectionSecret(field) && (
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 px-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              aria-label={`移除 ${label}`}
              disabled={busy || !status.configured || mustSignIn}
              checked={remove}
              onChange={(event) => {
                setRemove(event.target.checked);
                setError("");
                setSaved(false);
              }}
            />
            移除
          </label>
        )}
        <ConfirmButton
          className="min-h-11"
          variant="outline"
          aria-label={`更新 ${label}`}
          disabled={busy || mustSignIn || (!remove && !value.trim())}
          title="確認更新連線金鑰"
          description={`將${remove ? "移除" : "更新"} ${describeConnectionSecretChanges([field])}。`}
          confirm={remove ? "確認移除" : "確認更新"}
          dialogActionClassName="min-h-11"
          onConfirm={save}
        >
          更新
        </ConfirmButton>
      </div>
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {mustSignIn && (
        <Button
          asChild
          variant="outline"
          className="min-h-11 justify-self-start"
        >
          <a href={`/auth/github?${new URLSearchParams({ returnTo: secretReauthTarget })}`}>
            使用 GitHub 重新登入
          </a>
        </Button>
      )}
      {saved && (
        <p role="status" className="text-sm">
          已儲存連線金鑰設定。
        </p>
      )}
    </li>
  );
}
