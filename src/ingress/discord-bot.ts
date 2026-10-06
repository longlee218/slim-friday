import { Client, Events, GatewayIntentBits, type Interaction } from "discord.js";
import type { AgentConfig } from "../config/agent-config";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { createMessageHandler, type HandleTask } from "./discord-message-handler";
import { SAFE_MENTIONS } from "./discord-message-rules";

/** Client options: needed intents and a mention policy that never pings anyone. */
export const CLIENT_OPTIONS = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  allowedMentions: SAFE_MENTIONS,
};

/** Build the Discord bot (not connected until `login`). */
export function createDiscordBot(
  config: AgentConfig,
  handleTask: HandleTask,
  handleInteraction?: (i: Interaction) => Promise<void>,
) {
  const log = logger.child({ module: "discord-bot" });
  const client = new Client(CLIENT_OPTIONS);
  const onMessage = createMessageHandler({
    ownerId: config.ownerDiscordId!,
    botId: () => client.user?.id,
    handleTask,
  });

  client.on(Events.MessageCreate, (msg) => {
    void onMessage(msg);
  });
  // Button clicks (approvals); the handler never throws, void keeps the listener sync.
  if (handleInteraction) client.on(Events.InteractionCreate, (i) => void handleInteraction(i));
  client.on(Events.ClientReady, (c) => log.info({ bot: c.user.tag }, "discord ready"));
  client.on(Events.Error, (err) => log.error({ err: errText(err) }, "discord client error"));

  return { client, onMessage };
}
