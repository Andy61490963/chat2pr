import { posix } from "node:path";

const protectedPaths = [
  ".github/",
  ".env",
  "infra/",
  "migrations/",
  "dockerfile",
  "compose.",
  "server/policy",
  "server/repository-safety",
  "server/auth",
  "server/proxy",
];

// 純文字沿用路徑片段比對；萬用字元依儲存庫的 POSIX 路徑比對。
export function sensitiveRepoPath(path: string, rules: string[] = []) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    protectedPaths.some((prefix) => normalized.includes(prefix)) ||
    privateRepoPath(path, rules)
  );
}

/** 唯讀建置判讀可讀 CI，仍排除機密位置及管理者指定的敏感路徑。 */
export function privateRepoPath(path: string, rules: string[] = []) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (
    /(?:^|\/)(?:\.codex(?:-service)?|\.ssh|\.aws|\.azure|\.gnupg|\.local)(?:\/|$)|(?:^|\/)(?:\.npmrc|\.git-credentials|(?:auth|credentials|secrets?|appsettings(?:\..*)?|service-account.*)\.json)$/.test(
      normalized,
    )
  )
    return true;
  if (normalized.includes(".env")) return true;
  return rules.some((value) => {
    const pattern = value.trim().replaceAll("\\", "/").toLowerCase();
    if (!pattern) return false;
    if (!/[*?\[{}]/.test(pattern)) return normalized.includes(pattern);
    const glob = pattern.endsWith("/") ? pattern + "**" : pattern;
    return (
      posix.matchesGlob(normalized, glob) ||
      posix.matchesGlob(normalized, "**/" + glob)
    );
  });
}

export function containsRepositoryCredential(source: string) {
  return (
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|github_pat_[\w]{10,}|gh[pousr]_[\w]{10,})/.test(
      source,
    ) ||
    /["'](?:refresh_token|access_token|client_secret|private_key)["']\s*:\s*["'][^"'\s]{8,}/i.test(
      source,
    )
  );
}
