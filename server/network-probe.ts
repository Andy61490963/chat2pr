import { connect } from "node:net";
import { z } from "zod";

/** 從主機實測 TCP 連線；只回報連得到與否，不送任何資料。 */
export const ProbeTargets = z
  .array(
    z.object({
      host: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[A-Za-z0-9.:_-]+$/, "主機名稱格式不正確"),
      port: z.number().int().min(1).max(65535),
    }),
  )
  .max(10);

export interface ProbeResult {
  host: string;
  port: number;
  reachable: boolean;
  detail: string;
}

const reasons: Record<string, string> = {
  ECONNREFUSED: "主機有回應，但這個連接埠拒絕連線",
  ENOTFOUND: "找不到這個主機名稱",
  EAI_AGAIN: "暫時查不到這個主機名稱",
  EHOSTUNREACH: "這台伺服器沒有通往這個位址的路由",
  ENETUNREACH: "這台伺服器沒有通往這個網段的路由",
};

export function probeOne(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port });
    const done = (reachable: boolean, detail: string) => {
      socket.destroy();
      resolve({ host, port, reachable, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () =>
      done(true, `連得到（${Date.now() - started} ms）`),
    );
    socket.once("timeout", () =>
      done(
        false,
        `${Math.round(timeoutMs / 1000)} 秒內沒有回應；這台伺服器可能不在那個網路裡（需要 VPN 或 Tailscale subnet router）`,
      ),
    );
    socket.once("error", (e: NodeJS.ErrnoException) =>
      done(false, reasons[e.code ?? ""] ?? `連線失敗（${e.code ?? "未知"}）`),
    );
  });
}

export const probeTargets = (targets: z.infer<typeof ProbeTargets>) =>
  Promise.all(targets.map((t) => probeOne(t.host, t.port)));
