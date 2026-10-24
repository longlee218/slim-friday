import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { Log } from "../ports/log";
import type { HubContext } from "./hub-context";

/** What the hub tells the app about a scope that has been quiet (the app may keep notes of it). */
export interface IdleClose {
  botId: BotId;
  /** Key of the quiet scope: the bot id (direct) or `<botId>@<groupId>`. */
  key: string;
  /** The group of a group scope; unset for a direct scope. */
  groupId?: GroupId;
  /** Conversations of the scope: the bot's direct one, or every conversation of the group. */
  conversationIds: ConversationId[];
  /** Epoch ms of the scope's last flush (0 when never flushed): only messages since then are new. */
  since: number;
}

/** Hook called for each quiet scope. */
export type IdleCloseHook = (e: IdleClose) => void | Promise<void>;

/**
 * Tell the hook about every scope whose last run finished at least `idleCloseMs` ago and that was not flushed
 * since, then mark it flushed. Driven by the finish time stored per scope, not by a session closing (a run
 * closes its session when it ends). A scope with a run executing in this process is skipped.
 */
export async function sweepQuietScopes(ctx: HubContext, hook?: IdleCloseHook): Promise<void> {
  if (!hook) return;
  const { store, clock, log } = ctx.deps;
  const now = clock.now();
  for (const key of await store.scopes.quiet(now - ctx.limits.idleCloseMs + 1)) {
    if (ctx.runs.has(key)) continue;
    const [botId = key, groupId] = key.split("@");
    const conversationIds = groupId
      ? (await store.conversations.list())
          .filter((c) => c.kind === "group" && c.groupId === groupId)
          .map((c) => c.id)
      : [(await store.conversations.direct(botId))?.id].filter((c): c is string => !!c);
    const since = (await store.scopes.get(key))?.lastFlushedAt ?? 0;
    report(hook, { botId, key, ...(groupId && { groupId }), conversationIds, since }, log);
    await store.scopes.flushed(key, now);
  }
}

/** Tell the hook (not awaited); a throw or a rejection is logged, never passed on. */
function report(hook: IdleCloseHook, event: IdleClose, log?: Log): void {
  const fail = (err: unknown) =>
    log?.error(
      { error: err instanceof Error ? err.message : String(err), botId: event.botId },
      "hub.idle_close_hook",
    );
  try {
    Promise.resolve(hook(event)).catch(fail);
  } catch (err) {
    fail(err);
  }
}
