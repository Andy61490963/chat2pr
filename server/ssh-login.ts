import { createHash } from "node:crypto";
import { Client } from "ssh2";
import { z } from "zod";

/** 主機執行器實際登入一次登記的 SSH 主機（不執行任何命令），並回報主機金鑰指紋。 */
export const SshLoginInput = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(128),
  password: z.string().max(1000).optional(),
  privateKey: z.string().max(20000).optional(),
  passphrase: z.string().max(1000).optional(),
  hostKey: z.string().max(200).nullable().optional(),
});
export type SshLoginInput = z.infer<typeof SshLoginInput>;

export interface SshLoginResult {
  ok: boolean;
  detail: string;
  hostKey?: string;
}

export const fingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64")}`;

export function testSshLogin(
  input: SshLoginInput,
  timeoutMs = 15000,
): Promise<SshLoginResult> {
  return new Promise((resolve) => {
    const client = new Client();
    let hostKey = "",
      done = false;
    const finish = (result: SshLoginResult) => {
      if (done) return;
      done = true;
      client.end();
      resolve(result);
    };
    client.on("ready", () => finish({ ok: true, detail: "登入成功", hostKey }));
    client.on("error", (error: Error & { level?: string; code?: string }) =>
      finish({
        ok: false,
        detail:
          hostKey && input.hostKey && input.hostKey !== hostKey
            ? "主機金鑰和上次登入時不同，已停止連線。確認主機沒有被更換或冒充後，刪除這台主機再重新登記。"
            : error.level === "client-authentication"
              ? "主機拒絕登入，請檢查帳號、密碼或私鑰。"
              : error.level === "client-timeout"
                ? "在時限內沒有完成登入，主機可能連不到（例如需要 VPN 或路由）。"
                : error.code === "ECONNREFUSED"
                  ? "主機有回應，但 SSH 連接埠拒絕連線。"
                  : error.code === "ENOTFOUND"
                    ? "找不到這個主機名稱。"
                    : "連不上這台主機，請檢查位址、連接埠與網路路由。",
      }),
    );
    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        ...(input.privateKey
          ? { privateKey: input.privateKey, passphrase: input.passphrase }
          : { password: input.password, tryKeyboard: true }),
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => {
          hostKey = fingerprint(key);
          return !input.hostKey || input.hostKey === hostKey;
        },
      });
      // Windows OpenSSH 等主機常用鍵盤互動式驗證送出密碼。
      client.on("keyboard-interactive", (_n, _i, _l, prompts, reply) =>
        reply(prompts.map(() => input.password ?? "")),
      );
    } catch {
      finish({ ok: false, detail: "私鑰格式無法讀取，或密碼片語不正確。" });
    }
  });
}
