import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { Log } from "../ports/log";
import type { PoolEntry } from "./session-pool";

/** What the hub tells the app about a session it is closing for being quiet (the app may keep notes of it). */
export interface IdleClose {
  botId: BotId;
  /** Key of the closed session: the bot id (direct) or `<botId>@<groupId>`. */
  key: string;
  /** The group of a group session; unset for a direct session. */
  groupId?: GroupId;
  /** Conversations the session answered, in the order it first answered them. */
  conversationIds: ConversationId[];
  /** Epoch milliseconds the session was opened. */
  since: number;
}

/** Hook called for each session closed for being quiet. */
export type IdleCloseHook = (e: IdleClose) => void | Promise<void>;

/** Tell the hook about a quiet session (not awaited); a throw or a rejection is logged, never passed on. */
export function reportIdleClose(
  hook: IdleCloseHook | undefined,
  entry: PoolEntry,
  log?: Log,
): void {
  if (!hook) return;
  const fail = (err: unknown) =>
    log?.error(
      { error: err instanceof Error ? err.message : String(err), botId: entry.bot.id },
      "hub.idle_close_hook",
    );
  try {
    const event: IdleClose = {
      botId: entry.bot.id,
      key: entry.key,
      ...(entry.groupId && { groupId: entry.groupId }),
      conversationIds: [...entry.conversations],
      since: entry.openedAt,
    };
    Promise.resolve(hook(event)).catch(fail);
  } catch (err) {
    fail(err);
  }
}
