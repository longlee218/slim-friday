import { type BotRuntimeSpec, isTicketScopeKey } from "@friday/core";

/**
 * Name of a session's scratch dir under the scratch root: the bot id for its direct session,
 * `<botId>_<groupId>` for a group session, `<botId>_<groupId>_ticket` for its ticket session of the group (both
 * may run at once, and a session open rebuilds files in its dir). Ids never contain `_`, so the name is
 * unambiguous; the session key's `@` and `#` are avoided because their handling in the SDK sandbox layer is not
 * verified.
 */
export function scratchName(spec: BotRuntimeSpec): string {
  if (!spec.groupId) return spec.bot.id;
  const ticket = spec.sessionKey !== undefined && isTicketScopeKey(spec.sessionKey);
  return `${spec.bot.id}_${spec.groupId}${ticket ? "_ticket" : ""}`;
}
