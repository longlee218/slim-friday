import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { WakeRow } from "../domain/wake";
import { dayOf } from "./event-pump";
import { type AdmitOpts, type HubContext, notice } from "./hub-context";
import { errText, type WakeOpts, type WakeOutcome } from "./hub-types";
import type { QueuedWake } from "./session-pool";
import { sessionScope } from "./session-scope";
import { dispatch } from "./turn-dispatch";
import { startPump } from "./turn-pump";

/** Deliver one message to one bot unless a cap says stop. */
export async function wake(
  ctx: HubContext,
  botId: BotId,
  conversationId: ConversationId,
  sender: Author,
  text: string,
  hop: number,
  opts: WakeOpts = {},
): Promise<WakeOutcome> {
  const { store } = ctx.deps;
  const bot = await store.bots.get(botId);
  const conv = await store.conversations.get(conversationId);
  if (!bot || !conv) return { ok: false, reason: "gone" };
  // The wake is stored first, so a blocked one is on record with its reason.
  const row = await ctx.wakeLog.create({
    conversationId,
    targetBot: botId,
    sender,
    intent: opts.intent ?? "request",
    hop,
    text,
    ...(opts.handoff && { handoff: true }),
    ...(opts.ticketId && { ticketId: opts.ticketId }),
    ...(opts.rewake && { rewake: true }),
    ...(opts.attachments && { attachments: opts.attachments }),
    ...(opts.chainId && { chainId: opts.chainId }),
    ...(opts.parentWakeId && { parentWakeId: opts.parentWakeId }),
  });
  return ctx.admit(row, bot, opts);
}

/** Check the caps for a stored wake, then hand it to the bot's session (now, or after its current turn). */
export async function admit(
  ctx: HubContext,
  row: WakeRow,
  bot: Bot,
  opts: AdmitOpts = {},
): Promise<WakeOutcome> {
  const { store, clock } = ctx.deps;
  const { conversationId, sender, text, hop } = row;
  // The session follows the conversation: the bot's direct one, or its one for that group (members only).
  const conv = await store.conversations.get(conversationId);
  const group = conv?.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
  const scope = conv && sessionScope(bot, conv, group, ctx.deps.scopeBot);
  if (!scope) {
    await ctx.wakeLog.dropped(row.id);
    return { ok: false, reason: "gone" };
  }
  // A result that returns to the bot that gave the work is checked as if it were at the last allowed hop.
  const w = {
    conversationId,
    sender,
    target: row.targetBot,
    text,
    hop: opts.exemptFromHops ? Math.min(hop, ctx.limits.maxHops) : hop,
  };
  const verdict = ctx.guard.check(w);
  if (!verdict.ok) {
    await ctx.wakeLog.blocked(row, verdict.reason);
    await notice(ctx, conversationId, verdict.reason);
    return { ok: false, reason: verdict.reason };
  }
  if ((await store.spend.total(bot.id, dayOf(clock.now()))) >= ctx.limits.maxSpendPerBotPerDayUsd) {
    await ctx.wakeLog.blocked(row, "spend");
    await notice(ctx, conversationId, "spend");
    return { ok: false, reason: "spend" };
  }

  const entry = await ctx.pool.get(scope);
  if (!entry.pumping) {
    entry.pumping = true;
    startPump(ctx, entry).catch((err) =>
      ctx.deps.log?.error({ error: errText(err), botId: bot.id }, "hub.pump_failed"),
    );
  }
  ctx.guard.record(w);
  // One turn at a time per bot: a message that arrives mid-turn waits, so each answer goes where it was asked.
  const queued: QueuedWake = {
    wakeId: row.id,
    conversationId,
    sender,
    text,
    hop,
    intent: row.intent,
    ...(row.handoff && { handoff: true }),
    ...(row.ticketId && { ticketId: row.ticketId }),
    ...(row.rewake && { rewake: true }),
    ...(opts.interrupted && { interrupted: true }),
    ...(opts.quote && { quote: opts.quote }),
    ...(row.attachments && { attachments: row.attachments }),
  };
  if (entry.busy) entry.queue.push(queued);
  else await dispatch(ctx, entry, queued);
  return { ok: true, wakeId: row.id };
}
