import { Client, Events, GatewayIntentBits, type Interaction } from "discord.js";
import type { AgentConfig } from "../config/agent-config";
import { createAdminHandler } from "../discord-setup/admin-handler";
import { type DiscordSetup, EMPTY_SETUP } from "../discord-setup/discord-setup-config";
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
  setup: DiscordSetup = EMPTY_SETUP,
) {
  const log = logger.child({ module: "discord-bot" });
  const client = new Client(CLIENT_OPTIONS);
  const onMessage = createMessageHandler({
    ownerId: config.ownerDiscordId!,
    botId: () => client.user?.id,
    guildId: config.discordGuildId,
    handleTask,
    setup,
    // Admin commands (init:workspace) run outside the task handler, behind their own gate.
    admin: createAdminHandler({
      home: config.agentHome,
      guildId: config.discordGuildId,
      ownerId: config.ownerDiscordId ?? "",
      botId: () => client.user?.id,
      setup,
    }),
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
