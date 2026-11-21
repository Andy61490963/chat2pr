import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  connectionSecretFields,
  type ConnectionSecretField,
  type ConnectionSecretPatch,
  type ConnectionSecretStatus,
} from "../shared/connection-secrets.js";
import { secretsPath, type Secrets } from "./config.js";

// 鎖檔超過這個時間仍在，代表上一次寫入的程序中途結束；清掉重試，否則之後永遠存不了。
const staleLockMs = 60_000;

function acquireLock(lock: string) {
  try {
    return openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - statSync(lock).mtimeMs < staleLockMs) throw error;
    unlinkSync(lock);
    return openSync(lock, "wx", 0o600);
  }
}

/** 兩個主機程序共用同一把鎖，避免本機設定頁與看板互相覆蓋設定。 */
export function editSecrets<T>(
  path: string,
  edit: (stored: Secrets) => { result: T; save: boolean },
  create = false,
): T {
  const lock = `${path}.lock`;
  const fd = acquireLock(lock);
  try {
    let stored: Secrets = {};
    try {
      stored = JSON.parse(readFileSync(path, "utf8"));
      if (!stored || typeof stored !== "object" || Array.isArray(stored))
        throw new Error("機密設定檔格式不正確");
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    const { result, save } = edit(stored);
    if (save) {
      const tmp = `${path}.${randomUUID()}.tmp`;
      const tempFd = openSync(tmp, "wx", 0o600);
      try {
        try {
          if (process.platform !== "win32") fchmodSync(tempFd, 0o600);
          writeFileSync(tempFd, JSON.stringify(stored, null, 2), "utf8");
          fsyncSync(tempFd);
        } finally {
          closeSync(tempFd);
        }
        renameSync(tmp, path);
      } catch (error) {
        unlinkSync(tmp);
        throw error;
      }
    }
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function applyConnectionSecrets(
  stored: Secrets,
  patch: ConnectionSecretPatch,
) {
  const updatedAt = new Date().toISOString();
  const changed: ConnectionSecretField[] = [];
  for (const field of connectionSecretFields) {
    const value = patch[field];
    if (value === undefined || (stored[field] || null) === value) continue;
    if (value === null) delete stored[field];
    else stored[field] = value;
    stored.connectionSecretUpdatedAt = {
      ...stored.connectionSecretUpdatedAt,
      [field]: updatedAt,
    };
    changed.push(field);
  }
  return changed;
}

export function connectionSecretStatus(
  stored: Secrets,
): ConnectionSecretStatus {
  return Object.fromEntries(
    connectionSecretFields.map((field) => {
      const updatedAt = stored.connectionSecretUpdatedAt?.[field];
      return [
        field,
        {
          configured: !!stored[field],
          updatedAt:
            typeof updatedAt === "string" &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(updatedAt) &&
            Number.isFinite(Date.parse(updatedAt))
              ? updatedAt
              : null,
        },
      ];
    }),
  ) as ConnectionSecretStatus;
}

export function updateConnectionSecrets(
  patch: ConnectionSecretPatch,
  path = secretsPath,
) {
  return editSecrets(path, (stored) => {
    const changed = applyConnectionSecrets(stored, patch);
    return { result: { changed }, save: changed.length > 0 };
  });
}
