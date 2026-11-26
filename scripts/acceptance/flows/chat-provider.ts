import Fastify from "fastify";
import { Agent, fetch as discordFetch } from "undici";
import { z, ZodError } from "zod";
import { discordId } from "../../../server/chat-platform.js";
import { instanceName } from "../../../server/config.js";
import {
  DiscordChatPlatform,
  discordRest,
} from "../../../server/discord-platform.js";

function requireAcceptance() {
  if (instanceName() === "production" || process.env.NODE_ENV === "production")
    throw new Error("聊天替身與路由只能用於具名驗收實例");
}

export interface AcceptanceOrigins {
  chatOrigin?: string;
  githubOrigin?: string;
  archiveOrigin?: string;
}

// 與驗收啟動器保留的正式 app、runner、代理及資料庫埠一致。
const productionPorts = new Set([
  "4310",
  "4311",
  "4312",
  "4313",
  "4314",
  "5439",
]);
// 直接連到已核對的數字位址，忽略程序或呼叫端設定的 HTTP 代理。
const direct = { dispatcher: new Agent(), redirect: "error" } as const;

function isLoopback(url: URL) {
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
}

function localUrl(url: URL) {
  if (
    !isLoopback(url) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    productionPorts.has(url.port)
  )
    throw new Error("驗收路由只允許非正式埠的本機 HTTP 服務");
  // 固定數字位址，避免 localhost 的名稱解析受主機設定影響。
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function localOrigin(value: string | undefined) {
  if (value === undefined) return undefined;
  const url = localUrl(new URL(value));
  if (url.href !== url.origin + "/")
    throw new Error("驗收對應必須是本機服務 origin");
  return url.origin;
}

/** 先建立再交給驗收程序的 globalThis.fetch，避免轉送時呼叫到自己。 */
export function createAcceptanceFetch(
  origins: AcceptanceOrigins,
): typeof fetch {
  requireAcceptance();
  const transport = globalThis.fetch;
  const chat = localOrigin(origins.chatOrigin);
  const github = localOrigin(origins.githubOrigin);
  const archive = localOrigin(origins.archiveOrigin);
  const routes = new Map([
    ["https://api.line.me", chat],
    ["https://discord.com", chat],
    ["https://api.github.com", github],
    ["https://codeload.github.com", archive],
  ]);
  return async (input, init) => {
    requireAcceptance();
    const source = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (source.username || source.password)
      throw new Error("驗收路由拒絕含帳密的網址");
    const request = new Request(input, init);
    let target: URL;
    if (isLoopback(source)) {
      target = localUrl(source);
    } else {
      const tarball =
        source.origin === "https://api.github.com" &&
        /^\/repos\/[^/]+\/[^/]+\/tarball(?:\/|$)/.test(source.pathname);
      let origin = tarball ? (archive ?? github) : routes.get(source.origin);
      if (
        source.origin === "https://github.com" &&
        source.pathname === "/login/oauth/access_token" &&
        request.method === "POST"
      )
        origin = github;
      if (!origin || source.protocol !== "https:")
        throw new Error("驗收請求沒有對應的本機服務");
      // pathname 可由雙斜線開頭，只複製欄位才能保證目的主機固定。
      target = new URL(origin);
      target.pathname = source.pathname;
      target.search = source.search;
    }
    return transport(new Request(target, request), direct);
  };
}

export interface ChatDelivery {
  readonly sequence: number;
  readonly platform: "line" | "discord";
  readonly groupId: string;
  readonly kind:
    "push" | "reply" | "message" | "callback" | "edit" | "followup";
  readonly messageId: string;
  readonly text: string;
  readonly ephemeral?: true;
}

const identifier = z.string().min(1);
const lineMessages = z
  .array(z.object({ type: z.literal("text"), text: identifier }))
  .min(1)
  .max(5);
const discordMessage = z.object({
  content: z.string(),
  flags: z.number().int().optional(),
  nonce: z.string().optional(),
  enforce_nonce: z.boolean().optional(),
});
interface DiscordInteraction {
  id: string;
  applicationId: string;
  token: string;
  channelId: string;
}

/** 每次啟動各自持有送達紀錄、一次性回覆權杖、訊息編號及配額。 */
export async function startChatProvider() {
  requireAcceptance();
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async () => {
    requireAcceptance();
  });
  app.setErrorHandler((error, _req, res) => {
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    res.code(status).send({ message: "驗收服務無法處理這個請求" });
  });
  app.setNotFoundHandler((_req, res) =>
    res.code(404).send({ message: "未知的驗收端點" }),
  );
  const records: ChatDelivery[] = [];
  let nextId = 100000000000000000n;
  const newId = () => String(++nextId);
  function record(delivery: Omit<ChatDelivery, "sequence">) {
    records.push(Object.freeze({ sequence: records.length + 1, ...delivery }));
  }

  const replies = new Map<string, { groupId: string; used: boolean }>();
  const pushes = new Map<string, string>();
  const quota = 10000;
  const memberCount = 1;
  let used = 0;
  const line = "/v2/bot";
  const profile = (userId: string) => ({ userId, displayName: "驗收成員" });
  app.get(line + "/info", () => ({
    userId: "U-demo-bot",
    displayName: "驗收機器人",
    basicId: "@demo",
  }));
  app.get<{ Params: { userId: string } }>(line + "/profile/:userId", (req) =>
    profile(req.params.userId),
  );
  app.get<{ Params: { groupId: string } }>(
    line + "/group/:groupId/summary",
    (req) => ({
      groupId: req.params.groupId,
      groupName: "驗收群組",
    }),
  );
  for (const kind of ["group", "room"]) {
    app.get(line + "/" + kind + "/:groupId/members/count", () => ({
      count: memberCount,
    }));
    app.get<{ Params: { userId: string } }>(
      line + "/" + kind + "/:groupId/member/:userId",
      (req) => profile(req.params.userId),
    );
  }
  app.get(line + "/message/quota", () => ({ type: "limited", value: quota }));
  app.get(line + "/message/quota/consumption", () => ({ totalUsage: used }));
  function acceptLine(
    kind: "push" | "reply",
    groupId: string,
    messages: z.infer<typeof lineMessages>,
  ) {
    return {
      sentMessages: messages.map(({ text }) => {
        const id = newId();
        record({ platform: "line", groupId, kind, messageId: id, text });
        return { id };
      }),
    };
  }
  app.post(line + "/message/push", (req, res) => {
    const { to, messages } = z
      .object({ to: identifier, messages: lineMessages })
      .parse(req.body);
    const key = req.headers["x-line-retry-key"];
    if (typeof key === "string") {
      const accepted = pushes.get(key);
      if (accepted)
        return res
          .code(409)
          .header("x-line-accepted-request-id", accepted)
          .send({});
    }
    if (used + memberCount > quota)
      return res
        .code(429)
        .send({ message: "You have reached your monthly limit." });
    const result = acceptLine("push", to, messages);
    if (typeof key === "string") pushes.set(key, result.sentMessages[0].id);
    used += memberCount;
    return result;
  });
  app.post(line + "/message/reply", (req, res) => {
    const { replyToken, messages } = z
      .object({ replyToken: identifier, messages: lineMessages })
      .parse(req.body);
    const reply = replies.get(replyToken);
    if (!reply || reply.used)
      return res.code(400).send({ message: "Invalid reply token" });
    reply.used = true;
    return acceptLine("reply", reply.groupId, messages);
  });

  const discord = "/api/v10";
  const nonces = new Map<
    string,
    { id: string; channel_id: string; content: string }
  >();
  const dmChannels = new Map<string, string>();
  const interactions = new Map<
    string,
    DiscordInteraction & {
      original?: {
        id: string;
        channel_id: string;
        content: string;
        flags: number;
      };
    }
  >();
  function recordDiscord(
    kind: "message" | "callback" | "edit" | "followup",
    channel: string,
    id: string,
    text: string,
    flags = 0,
  ) {
    record({
      platform: "discord",
      groupId: discordId(channel),
      kind,
      messageId: discordId(id),
      text,
      ...(flags & 64 ? { ephemeral: true } : {}),
    });
  }
  app.put(discord + "/applications/:id/commands", (req) => req.body);
  app.put(
    discord + "/channels/:channel/messages/:message/reactions/:emoji/@me",
    (_req, res) => res.code(204).send(),
  );
  app.post(discord + "/users/@me/channels", (req) => {
    const { recipient_id } = z
      .object({ recipient_id: identifier })
      .parse(req.body);
    const id = dmChannels.get(recipient_id) ?? newId();
    dmChannels.set(recipient_id, id);
    return { id, type: 1 };
  });
  app.post<{ Params: { channel: string } }>(
    discord + "/channels/:channel/messages",
    (req) => {
      const { content, nonce, enforce_nonce } = discordMessage.parse(req.body);
      const channel = req.params.channel;
      const key = JSON.stringify([channel, nonce]);
      if (enforce_nonce && nonce) {
        const previous = nonces.get(key);
        if (previous) return previous;
      }
      const message = { id: newId(), channel_id: channel, content };
      if (nonce) nonces.set(key, message);
      recordDiscord("message", channel, message.id, content);
      return message;
    },
  );
  app.post<{ Params: { id: string; token: string } }>(
    discord + "/interactions/:id/:token/callback",
    (req, res) => {
      const state = interactions.get(req.params.token);
      if (!state || state.id !== req.params.id)
        return res.code(404).send({ message: "未知的互動事件" });
      if (state.original)
        return res.code(400).send({ message: "互動事件已回覆" });
      const body = z
        .object({
          type: z.union([z.literal(4), z.literal(5)]),
          data: z
            .object({
              content: z.string().optional(),
              flags: z.number().optional(),
            })
            .optional(),
        })
        .parse(req.body);
      const id = newId(),
        content = body.data?.content ?? "";
      state.original = {
        id,
        channel_id: state.channelId,
        content,
        flags: body.data?.flags ?? 0,
      };
      recordDiscord(
        "callback",
        state.channelId,
        id,
        content,
        state.original.flags,
      );
      return res.code(204).send();
    },
  );
  const webhook = discord + "/webhooks/:applicationId/:token";
  type WebhookParams = Pick<DiscordInteraction, "applicationId" | "token">;
  function original(params: WebhookParams) {
    const state = interactions.get(params.token);
    return state?.applicationId === params.applicationId
      ? state.original
      : undefined;
  }
  app.route<{ Params: WebhookParams & { message: string } }>({
    method: ["GET", "PATCH"],
    url: webhook + "/messages/:message",
    handler(req, res) {
      const message =
        req.params.message === "@original" ? original(req.params) : undefined;
      if (!message) return res.code(404).send({ message: "找不到原互動訊息" });
      if (req.method === "PATCH") {
        message.content = discordMessage.parse(req.body).content;
        recordDiscord(
          "edit",
          message.channel_id,
          message.id,
          message.content,
          message.flags,
        );
      }
      return message;
    },
  });
  app.post<{ Params: WebhookParams }>(webhook, (req, res) => {
    const anchor = original(req.params);
    if (!anchor) return res.code(404).send({ message: "找不到原互動訊息" });
    const { content, flags } = discordMessage.parse(req.body);
    const message = { id: newId(), channel_id: anchor.channel_id, content };
    recordDiscord("followup", anchor.channel_id, message.id, content, flags);
    return message;
  });

  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  // Discord REST 有獨立傳輸入口，jobs 的實際平台也必須走本機。
  const rest = discordRest("AcceptanceDiscord266");
  rest.options.api = origin + "/api";
  rest.options.makeRequest = (url, init) => {
    requireAcceptance();
    return discordFetch(localUrl(new URL(url)), { ...init, ...direct });
  };
  return {
    origin,
    discord: new DiscordChatPlatform(rest),
    get records(): readonly ChatDelivery[] {
      return records.slice();
    },
    async groupMessages(groupId: string) {
      return records
        .filter((r) => r.groupId === groupId && !r.ephemeral && r.text)
        .map((r) => r.text);
    },
    registerLineReply(token: string, groupId: string) {
      if (replies.has(token)) throw new Error("LINE 回覆權杖已登記");
      replies.set(token, { groupId, used: false });
    },
    registerDiscordInteraction(event: DiscordInteraction) {
      if (interactions.has(event.token))
        throw new Error("Discord 互動事件已登記");
      interactions.set(event.token, { ...event });
    },
    async close() {
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
      await app.close();
    },
  };
}
