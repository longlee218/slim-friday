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

/** Failed flushes in a row before a scope is marked flushed anyway. */
const FLUSH_TRIES = 3;
/** Failed flushes in a row per scope key, per hub (in memory: a restart gives a scope new tries). */
const flushFails = new WeakMap<HubContext, Map<string, number>>();
/** The failure counts of this hub. */
function failsOf(ctx: HubContext): Map<string, number> {
  const m = flushFails.get(ctx) ?? new Map<string, number>();
  flushFails.set(ctx, m);
  return m;
}

/**
 * Tell the hook about every scope whose last run finished at least `idleCloseMs` ago and that was not flushed
 * since, then mark it flushed once the hook succeeded. Driven by the finish time stored per scope, not by
 * a session closing (a run closes its session when it ends). A scope with a run executing in this process is skipped.
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
    // Marked flushed only after the hook succeeded: a failed flush is tried again by the next sweep,
    // at most FLUSH_TRIES times in a row (each try calls a model), then given up with a warning.
    const fails = failsOf(ctx);
    if (
      await report(hook, { botId, key, ...(groupId && { groupId }), conversationIds, since }, log)
    ) {
      fails.delete(key);
      await store.scopes.flushed(key, now);
    } else if ((fails.get(key) ?? 0) + 1 >= FLUSH_TRIES) {
      fails.delete(key);
      log?.warn({ botId, key }, "hub.idle_flush_given_up");
      await store.scopes.flushed(key, now);
    } else fails.set(key, (fails.get(key) ?? 0) + 1);
  }
}

/** Tell the hook and wait for it; true when it succeeded. A throw or a rejection is logged, never passed on. */
async function report(hook: IdleCloseHook, event: IdleClose, log?: Log): Promise<boolean> {
  try {
    await hook(event);
    return true;
  } catch (err) {
    log?.error(
      { error: err instanceof Error ? err.message : String(err), botId: event.botId },
      "hub.idle_close_hook",
    );
    return false;
  }
}
