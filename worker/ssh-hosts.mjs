import { createHash } from "node:crypto";

/**
 * agentflow-ssh 的純函式：解析 AGENTFLOW_SSH_HOSTS、組 ssh／scp 參數、核對主機金鑰。
 * 主機金鑰指紋與伺服器的 server/ssh-login.ts 相同：SHA256 + base64（含補位）。
 */
export function parseHosts(raw) {
  if (!raw) return [];
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("AGENTFLOW_SSH_HOSTS 格式不正確");
  return list;
}

export const fingerprintOf = (base64Key) =>
  `SHA256:${createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64")}`;

const strip = (f) => f.replace(/=+$/, "");

/** 從 ssh-keyscan 的輸出挑出和登記指紋相同的那一行；沒有就回 undefined。 */
export function matchingKnownHost(scan, hostKey) {
  for (const line of scan.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || line.startsWith("#")) continue;
    if (strip(fingerprintOf(parts[2])) === strip(hostKey)) return line.trim();
  }
  return undefined;
}

export function commonOptions(host, knownHosts, pinned) {
  return [
    "-F",
    "/dev/null",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    `StrictHostKeyChecking=${pinned ? "yes" : "accept-new"}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "LogLevel=ERROR",
    ...(host.privateKey
      ? // 沒有密碼片語時不讓 ssh 改問密碼，失敗就直接結束。
        [
          "-o",
          "IdentitiesOnly=yes",
          ...(host.passphrase ? [] : ["-o", "BatchMode=yes"]),
        ]
      : [
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "PreferredAuthentications=password,keyboard-interactive",
        ]),
  ];
}

/** ssh 參數；command 是要在遠端執行的字串（多個參數以空白相接，和 ssh 本身相同）。 */
export function sshArgs(host, options, keyFile, command) {
  return [
    ...options,
    ...(keyFile ? ["-i", keyFile] : []),
    "-p",
    String(host.port),
    `${host.username}@${host.host}`,
    "--",
    command.join(" "),
  ];
}

/** scp 參數；以冒號開頭的路徑代表遠端。 */
export function scpArgs(host, options, keyFile, paths) {
  const remote = (p) =>
    p.startsWith(":") ? `${host.username}@${host.host}:${p.slice(1)}` : p;
  return [
    ...options,
    ...(keyFile ? ["-i", keyFile] : []),
    "-P",
    String(host.port),
    "-r",
    ...paths.map(remote),
  ];
}

/** 列出主機給 Codex 看，不含密碼與私鑰。 */
export const describe = (hosts) =>
  hosts.length
    ? hosts
        .map(
          (h) =>
            `${h.name}\t${h.username}@${h.host}:${h.port}\t${h.privateKey ? "私鑰" : "密碼"}${h.hostKey ? "" : "\t（主機金鑰未在看板核對過）"}${h.note ? `\t${h.note}` : ""}`,
        )
        .join("\n")
    : "這個專案沒有登記 SSH 主機。";
