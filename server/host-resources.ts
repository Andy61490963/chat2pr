import { cpus, freemem, totalmem } from "node:os";
import type Docker from "dockerode";
import type { HostResources } from "./capacity.js";

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * 執行器所在主機的 CPU 與記憶體，供派工判斷與系統頁建議同時執行數。
 * Docker 可用的 CPU／記憶體（例如 WSL2 虛擬機的上限）讀得到就一併回報。
 */
export async function hostResources(docker?: Docker): Promise<HostResources> {
  const host: HostResources = {
    cpus: cpus().length,
    memTotalMb: mb(totalmem()),
    memFreeMb: mb(freemem()),
  };
  try {
    const info = (await docker?.info()) as
      { NCPU?: number; MemTotal?: number } | undefined;
    if (info?.NCPU) host.dockerCpus = info.NCPU;
    if (info?.MemTotal) host.dockerMemMb = mb(info.MemTotal);
  } catch {
    // Docker 暫時無回應時只回報主機數值。
  }
  return host;
}
