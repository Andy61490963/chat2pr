import type { SpawnSyncReturns } from "node:child_process";

export const STALE_MS: number;
export const RETRY_MS: number;
export function statusAge(
  text: string | undefined,
  now?: number,
): number | null;
export function findTunnelTask(
  listing: string,
  root: string,
): { path: string; name: string; visible: boolean } | null;
export function tunnelWatchdog(deps: {
  root: string;
  note: (text: string) => void;
  platform?: string;
  read?: (path: string) => string;
  run?: (
    file: string,
    args: string[],
    options: object,
  ) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;
  now?: () => number;
}): () => "restarted" | "failed" | "not-found" | null;
