import Fastify from "fastify";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { secrets, secretsPath, token } from "./config.js";
import { tunnelProvider } from "./tunnel-provider.js";
import { parseConnectionSecrets } from "../shared/connection-secrets.js";
import { applyConnectionSecrets, editSecrets } from "./connection-secrets-file.js";

await mkdir(dirname(secretsPath), { recursive: true, mode: 0o700 });
if (process.platform === "win32") {
  const who = execFileSync("whoami", { encoding: "utf8" }).trim();
  execFileSync(
    "icacls",
    [dirname(secretsPath), "/inheritance:r", "/grant:r", `${who}:(OI)(CI)F`],
    { stdio: "ignore" },
  );
}
editSecrets(secretsPath, (stored) => {
  const save = !stored.sessionSecret || !stored.runnerSecret || !stored.githubWebhookSecret;
  stored.sessionSecret ||= token();
  stored.runnerSecret ||= token();
  stored.githubWebhookSecret ||= token();
  return { result: undefined, save };
}, true);
const setupToken = token();
await writeFile(
  ".local/setup-url.txt",
  `http://localhost:4311/#${setupToken}`,
  { mode: 0o600 },
);
const app = Fastify({ logger: false, bodyLimit: 65536 });
app.setErrorHandler((_err, _req, reply) =>
  reply
    .code(400)
    .send({ error: "設定格式不正確，請檢查欄位；輸入內容不會寫入日誌" }),
);
app.addHook("onRequest", async (req, reply) => {
  reply
    .header("Cache-Control", "no-store")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "no-referrer");
  if (!["localhost:4311", "127.0.0.1:4311"].includes(req.headers.host ?? ""))
    return reply.code(403).send({ error: "僅允許本機設定" });
  if (
    req.method !== "GET" &&
    !["http://localhost:4311", "http://127.0.0.1:4311"].includes(
      req.headers.origin ?? "",
    )
  )
    return reply.code(403).send({ error: "來源不符" });
  if (req.url.startsWith("/api/")) {
    const t = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (
      t.length !== setupToken.length ||
      !timingSafeEqual(Buffer.from(t), Buffer.from(setupToken))
    )
      return reply.code(401).send({ error: "請使用啟動時提供的本機設定連結" });
  }
});
app.get("/", async (_req, reply) =>
  reply
    .type("text/html")
    .send(await readFile(new URL("./setup.html", import.meta.url), "utf8")),
);
app.get("/api/status", async () => {
  const s = secrets();
  return {
    configured: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, !!v])),
    publicUrl: s.publicUrl ?? "",
    tunnelProvider: tunnelProvider(s) ?? "ngrok",
    callback: `${s.publicUrl ?? "https://你的固定網址"}/auth/github/callback`,
  };
});
app.post("/api/save", async (req, reply) => {
  const b = z
    .object({
      openaiKey: z.unknown().optional(),
      lineSecret: z.unknown().optional(),
      lineToken: z.unknown().optional(),
      discordToken: z.unknown().optional(),
      discordApplicationId: z.unknown().optional(),
      disableDiscord: z.literal("on").optional(),
      githubAppId: z.string().regex(/^\d*$/).optional(),
      githubPrivateKey: z.string().optional(),
      githubClientId: z.string().optional(),
      githubClientSecret: z.string().optional(),
      githubWebhookSecret: z.string().optional(),
      githubInstallationId: z.string().regex(/^\d*$/).optional(),
      ngrokToken: z.string().optional(),
      tunnelProvider: z.enum(["ngrok", "cloudflare", "external"]).optional(),
      cloudflareTunnelToken: z.string().optional(),
      cloudflareConfig: z.string().max(500).optional(),
      publicUrl: z.string().url().optional(),
    })
    .strict()
    .parse(req.body);
  if (
    b.publicUrl &&
    !(
      b.publicUrl.startsWith("https://") ||
      b.publicUrl === "http://localhost:4310"
    )
  )
    return reply.code(400).send({ error: "公開網址必須使用 HTTPS" });
  if (b.cloudflareConfig && !existsSync(b.cloudflareConfig))
    return reply
      .code(400)
      .send({ error: "找不到 Cloudflare 通道設定檔，請填完整路徑" });
  if (b.githubPrivateKey) {
    try {
      createPrivateKey(b.githubPrivateKey);
    } catch {
      return reply.code(400).send({ error: "GitHub 私鑰 PEM 格式不正確" });
    }
  }
  const { openaiKey, lineSecret, lineToken, discordToken, discordApplicationId, disableDiscord, ...other } = b;
  const connectionFields = { openaiKey, lineSecret, lineToken, discordToken, discordApplicationId };
  const parsed = parseConnectionSecrets(
    Object.fromEntries(Object.entries(connectionFields).filter(([, value]) => value !== undefined)),
  );
  if ("error" in parsed) return reply.code(400).send(parsed);
  if (disableDiscord && (parsed.patch.discordToken || parsed.patch.discordApplicationId))
    return reply
      .code(400)
      .send({ error: "請擇一停用 Discord 或更新 Discord 設定。" });
  try {
    editSecrets(secretsPath, (stored) => {
      applyConnectionSecrets(stored, disableDiscord
        ? { ...parsed.patch, discordToken: null, discordApplicationId: null }
        : parsed.patch);
      for (const [key, value] of Object.entries(other))
        if (value)
          Object.assign(stored, {
            [key]: key === "publicUrl" ? value.replace(/\/$/, "") : value,
          });
      return { result: undefined, save: true };
    });
  } catch {
    return reply.code(503).send({ error: "設定未能寫入主機，請確認設定檔可存取後再試。" });
  }
  return { ok: true };
});
app.get("/api/webhook-secret", async () => ({
  value: secrets().githubWebhookSecret,
}));
await app.listen({ port: 4311, host: "127.0.0.1" });
console.log(
  "本機機密設定頁已啟動。專用開啟連結已存入 .local/setup-url.txt，連結僅在此程序有效。",
);
