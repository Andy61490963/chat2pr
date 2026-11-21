import { secrets, type Secrets } from "./config.js";
import type { Database } from "./db.js";
import { startDiscord, type DiscordGateway } from "./discord.js";
import { DiscordChatPlatform, discordRest } from "./discord-platform.js";

export function discordConnection(
  db: Database,
  createGateway: () => DiscordGateway,
  read: () => Pick<Secrets, "discordToken" | "discordApplicationId"> = secrets,
) {
  let active: ReturnType<typeof startDiscord> | undefined;
  let platform: DiscordChatPlatform | undefined;
  let token: string | undefined;
  let applicationId: string | undefined;
  let stopped = false;
  let pending = Promise.resolve();

  function refresh() {
    pending = pending
      .then(async () => {
        if (stopped) return;
        const next = read();
        if (
          active &&
          token === next.discordToken &&
          applicationId === next.discordApplicationId
        )
          return;
        platform = undefined;
        await active?.stop();
        if (stopped) return;
        token = next.discordToken;
        applicationId = next.discordApplicationId;
        platform = token
          ? new DiscordChatPlatform(discordRest(token))
          : undefined;
        active = startDiscord(
          db,
          token,
          createGateway,
          platform,
          applicationId,
        );
      })
      .catch(() => {
        console.warn("Discord 連線未能套用最新設定，將再試一次。");
      });
    return pending;
  }

  return {
    refresh,
    platform: () => platform,
    async stop() {
      stopped = true;
      await pending;
      platform = undefined;
      await active?.stop();
    },
  };
}
