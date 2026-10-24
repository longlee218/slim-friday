import type { BotRuntimeSpec } from "@friday/core";

/**
 * Name of a session's scratch dir under the scratch root: the bot id for its direct session,
 * `<botId>_<groupId>` for a group session. Ids never contain `_`, so the name is unambiguous; the session key's `@`
 * is avoided because its handling in the SDK sandbox layer is not verified.
 */
export function scratchName(spec: BotRuntimeSpec): string {
  return spec.groupId ? `${spec.bot.id}_${spec.groupId}` : spec.bot.id;
}
