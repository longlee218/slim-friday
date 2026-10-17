import { Client, Events, GatewayIntentBits, type Interaction } from "discord.js";
import type { AgentConfig } from "../config/agent-config";
import { createAdminHandler } from "../discord-setup/admin-handler";
import type { ControlRun } from "../discord-setup/control-role-run";
import { type DiscordSetup, EMPTY_SETUP, opsIds } from "../discord-setup/discord-setup-config";
import type { InlineRunner } from "../memory/find-command-handler";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { createAttachmentDeps } from "./attachment-summary";
import { createChannelAdopter } from "./channel-adoption";
import { createMessageHandler, type HandleMessage } from "./discord-message-handler";
import { SAFE_MENTIONS } from "./discord-message-rules";
import type { LimitsView } from "./limits-copy";
import { createSlashHandler, registerSlashCommands } from "./slash-interaction";
import type { ThreadsPort } from "./thread-placement";

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
  handleMessage: HandleMessage & { control?: ControlRun; limits?: LimitsView },
  handleInteraction?: (i: Interaction) => Promise<void>,
  setup: DiscordSetup = EMPTY_SETUP,
  inline?: InlineRunner,
  threads?: ThreadsPort,
) {
  const log = logger.child({ module: "discord-bot" });
  const client = new Client(CLIENT_OPTIONS);
  const onMessage = createMessageHandler({
    ownerId: config.ownerDiscordId!,
    botId: () => client.user?.id,
    guildId: config.discordGuildId,
    handleMessage,
    setup,
    inline,
    threads,
    adoptChannel: createChannelAdopter({
      home: config.agentHome,
      ownerId: config.ownerDiscordId ?? "",
      guildId: config.discordGuildId,
      botId: () => client.user?.id,
      ops: opsIds(setup),
    }),
    attachments: createAttachmentDeps(config),
    // Admin commands (/init-workspace) run outside the turn handler, behind their own gate.
    admin: createAdminHandler({
      home: config.agentHome,
      guildId: config.discordGuildId,
      ownerId: config.ownerDiscordId ?? "",
      botId: () => client.user?.id,
      setup,
      inline,
      controlRun: handleMessage.control, // non-command owner text in #ops-control -> the control-channel role
    }),
  });

  client.on(Events.MessageCreate, (msg) => {
    void onMessage(msg);
  });
  // Button clicks (approvals); the handler never throws, void keeps the listener sync.
  if (handleInteraction) client.on(Events.InteractionCreate, (i) => void handleInteraction(i));
  // Native slash commands: same owner/guild/channel rules as a message (they run through `onMessage`).
  const onSlash = createSlashHandler({
    ownerId: config.ownerDiscordId!,
    onMessage,
    limits: handleMessage.limits,
  });
  client.on(Events.InteractionCreate, (i) => void onSlash(i));
  client.on(Events.ClientReady, (c) => {
    log.info({ bot: c.user.tag }, "discord ready");
    void registerSlashCommands(client, config.discordGuildId);
  });
  client.on(Events.Error, (err) => log.error({ err: errText(err) }, "discord client error"));

  return { client, onMessage };
}
