import type { Message } from "discord.js";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import type { MemoryRunner } from "../memory/memory-command-handler";
import { logEvent, logger } from "../observability/logger";
import { adminGate, parseAdminCommand } from "./admin-command";
import type { ControlRun } from "./control-role-run";
import type { DiscordSetup } from "./discord-setup-config";
import { initChannel } from "./init-channel";
import { initWorkspace } from "./init-workspace";
import { isPrivateChannel, type PrivateIds } from "./private-channels";

const log = logger.child({ module: "admin-handler" });

/** What admin handling needs. */
export interface AdminDeps {
  home: string;
  /** DISCORD_GUILD_ID (undefined: admin commands are refused). */
  guildId: string | undefined;
  ownerId: string;
  /** Id of the logged-in bot user. */
  botId: () => string | undefined;
  setup: DiscordSetup;
  /** Owner memory commands typed in #ops-control (global scope and `compact memory` only). */
  memory?: MemoryRunner;
  /** Runs the control-channel role for non-command text; absent = the help text. */
  controlRun?: ControlRun;
}

/**
 * Live privacy of the channel a message came from: false for threads and for channels without overwrites
 * (DMs), else the strict `isPrivateChannel` shape.
 */
export function liveIsPrivate(
  ch: { isThread(): boolean } & Partial<Parameters<typeof isPrivateChannel>[0]>,
  ids: PrivateIds,
): boolean {
  return (
    !ch.isThread() &&
    !!ch.permissionOverwrites &&
    isPrivateChannel({ permissionOverwrites: ch.permissionOverwrites }, ids)
  );
}

/**
 * Build the admin handler for messages routed as `control` (the owner check already ran in routing).
 * Gate order: pinned guild -> control channel id AND live privacy -> parse -> run. Outside the task
 * handler: no task row, no limiter, no agent.
 */
export function createAdminHandler(deps: AdminDeps) {
  return async function handleAdmin(msg: Message, prompt: string): Promise<void> {
    const botId = deps.botId();
    const ch = msg.channel;
    const reply = (content: string) =>
      msg.reply({ content, allowedMentions: SAFE_MENTIONS }).then(() => undefined);
    if (!botId || !msg.guild) {
      logEvent(log, "admin.refused", { reason: botId ? "no_guild" : "no_bot_id" }, "warn");
      return;
    }
    const gate = adminGate({
      guildPinned: !!deps.guildId,
      inPinnedGuild: msg.guildId === deps.guildId,
      isThread: ch.isThread(),
      channelId: ch.id,
      controlChannels: deps.setup.controlChannels,
      // Live check on the cached channel; a thread or DM channel has no overwrites -> not private.
      privateNow: liveIsPrivate(ch, { guildId: msg.guild.id, ownerId: deps.ownerId, botId }),
    });
    if (!gate.ok) {
      logEvent(log, "admin.refused", { channelId: ch.id, reply: gate.reply }, "warn");
      return void (await reply(gate.reply));
    }
    // `forget: global ...`, `compact memory`: after the same gate as admin commands.
    const memo = await deps.memory?.({ where: "control", channelId: ch.id, text: prompt });
    if (memo != null) return void (await reply(memo));
    const cmd = parseAdminCommand(prompt);
    const init = {
      home: deps.home,
      guild: msg.guild,
      ids: { guildId: msg.guild.id, ownerId: deps.ownerId, botId },
    };
    // Non-command text goes to the control-channel role (when one is registered and wired), else the help text.
    if (cmd.kind === "help" && (await deps.controlRun?.(msg, prompt, init))) return;
    if (cmd.kind !== "init_workspace" && cmd.kind !== "init_channel")
      return void (await reply(cmd.reply));
    await reply(
      cmd.kind === "init_channel"
        ? await initChannel(init, cmd.space, cmd.name)
        : await initWorkspace(init, cmd.name),
    );
  };
}
