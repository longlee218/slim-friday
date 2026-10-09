import type { Client } from "discord.js";
import { logEvent, logger } from "../observability/logger";
import { botPermissionReport } from "./private-channels";

const log = logger.child({ module: "ready-checks" });

/**
 * Warn when the bot holds Administrator in the pinned guild: Administrator bypasses channel overwrites, so
 * the private-channel model does not protect anything from it. Warn only (the owner keeps full control).
 * Returns whether the warning fired.
 */
export function warnIfBotAdministrator(client: Client, guildId: string | undefined): boolean {
  const perms = guildId ? client.guilds.cache.get(guildId)?.members.me?.permissions : undefined;
  if (!perms || !botPermissionReport(perms.bitfield).administrator) return false;
  logEvent(log, "discord.bot_administrator", { guildId }, "warn");
  return true;
}
