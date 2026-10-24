import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { WakeRow } from "../domain/wake";
import { block, capsCheck, createRun } from "../runs/run-create";
import { priorityOf } from "../runs/run-rules";
import type { AdmitOpts, HubContext } from "./hub-context";
import type { WakeOpts, WakeOutcome } from "./hub-types";
import { sessionScope } from "./session-scope";

/** Store one message to one bot as a queued run (blocked when a cap says stop); a worker runs it. */
export function wake(
  ctx: HubContext,
  botId: BotId,
  conversationId: ConversationId,
  sender: Author,
  text: string,
  hop: number,
  opts: WakeOpts = {},
): Promise<WakeOutcome> {
  return createRun(ctx, { botId, conversationId, sender, text, hop, opts });
}

/**
 * Check the caps for a run that is already stored and `queued` (a recovered one), give it the scope it
 * runs in, and hint the workers. A bot that is not in the conversation's group drops it.
 */
export async function admit(
  ctx: HubContext,
  row: WakeRow,
  bot: Bot,
  opts: AdmitOpts = {},
): Promise<WakeOutcome> {
  const { store } = ctx.deps;
  const conv = await store.conversations.get(row.conversationId);
  const group = conv?.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
  const scope = conv && sessionScope(bot, conv, group, ctx.deps.scopeBot);
  if (!scope) {
    await ctx.wakeLog.dropped(row.id);
    return { ok: false, reason: "gone" };
  }
  // Rows of older builds carry the bot id as scope; a group run belongs to the group scope.
  const priority = priorityOf(row.sender, row.ticketId);
  if (row.scopeKey !== scope.key || row.priority !== priority)
    await store.wakes.update(row.id, { scopeKey: scope.key, priority });
  const blocked = await capsCheck(ctx, row, opts.exemptFromHops);
  if (blocked) {
    await block(ctx, row, blocked);
    return { ok: false, reason: blocked };
  }
  ctx.hints.newRun(row.id);
  return { ok: true, wakeId: row.id };
}
