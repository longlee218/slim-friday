import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { BlockReason, WakeRow } from "../domain/wake";
import { dayOf } from "../hub/event-pump";
import { type HubContext, notice } from "../hub/hub-context";
import type { WakeOpts, WakeOutcome } from "../hub/hub-types";
import { sessionScope } from "../hub/session-scope";
import { priorityOf } from "./run-rules";

/** What `createRun` needs to store one run. */
export interface NewRun {
  botId: BotId;
  conversationId: ConversationId;
  sender: Author;
  text: string;
  hop: number;
  opts?: WakeOpts;
  /** Unique per conversation: a second run with the same key returns the first one. */
  dedupeKey?: string;
}

/**
 * Store one run as `queued` for a worker to claim, then hint the workers. The row is stored first and
 * checked after (the chain guard counts only rows stored before it); a cap or the spend limit turns it
 * into `blocked` with a notice. A dedupe key that is already used returns that run's outcome instead.
 */
export async function createRun(ctx: HubContext, r: NewRun): Promise<WakeOutcome> {
  const { store } = ctx.deps;
  const opts = r.opts ?? {};
  const bot = await store.bots.get(r.botId);
  const conv = await store.conversations.get(r.conversationId);
  if (!bot || !conv) return { ok: false, reason: "gone" };
  const group = conv.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
  const scope = sessionScope(bot, conv, group, ctx.deps.scopeBot);
  const row = ctx.wakeLog.build({
    conversationId: conv.id,
    targetBot: bot.id,
    sender: r.sender,
    intent: opts.intent ?? "request",
    hop: r.hop,
    text: r.text,
    scopeKey: scope?.key ?? bot.id,
    priority: priorityOf(r.sender, opts.ticketId),
    ...(r.dedupeKey && { dedupeKey: r.dedupeKey }),
    ...(opts.handoff && { handoff: true }),
    ...(opts.ticketId && { ticketId: opts.ticketId }),
    ...(opts.rewake && { rewake: true }),
    ...(opts.attachments && { attachments: opts.attachments }),
    ...(opts.chainId && { chainId: opts.chainId }),
    ...(opts.parentWakeId && { parentWakeId: opts.parentWakeId }),
  });
  const added = await store.wakes.insertDeduped(row);
  if (!added.inserted) return outcomeOf(added.existing);
  ctx.wakeLog.stored(row);
  // A bot that is not a member of the group has no session there: kept on record as dropped.
  if (!scope) {
    await ctx.wakeLog.dropped(row.id);
    return { ok: false, reason: "gone" };
  }
  const blocked = await capsCheck(ctx, row, opts.exemptFromHops);
  if (blocked) {
    await block(ctx, row, blocked);
    return { ok: false, reason: blocked };
  }
  ctx.hints.newRun(row.id);
  return { ok: true, wakeId: row.id };
}

/**
 * The chain caps and the daily spend cap for a stored run; the reason it may not run, or undefined.
 * `exemptFromHops`: a result going back to the bot that gave the work is checked as if at the last allowed hop.
 */
export async function capsCheck(
  ctx: HubContext,
  row: WakeRow,
  exemptFromHops?: boolean,
): Promise<BlockReason | undefined> {
  const { store, clock } = ctx.deps;
  const verdict = await ctx.guard.check({
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    sender: row.sender,
    target: row.targetBot,
    text: row.text,
    hop: exemptFromHops ? Math.min(row.hop, ctx.limits.maxHops) : row.hop,
  });
  if (!verdict.ok) return verdict.reason;
  const spent = await store.spend.total(row.targetBot, dayOf(clock.now()));
  return spent >= ctx.limits.maxSpendPerBotPerDayUsd ? "spend" : undefined;
}

/**
 * Mark a stored, never-claimed run `blocked` and tell the conversation once. The change is guarded on
 * `queued` and fence 0, so a run a worker already claimed (a lost race) is left to run.
 */
export async function block(ctx: HubContext, row: WakeRow, reason: BlockReason): Promise<void> {
  const { store, clock } = ctx.deps;
  const patch = { status: "blocked" as const, blockReason: reason, endedAt: clock.now() };
  if (!(await store.wakes.transition(row.id, row.leaseFence, ["queued"], patch))) return;
  // Writes the same values again and logs `wake.blocked` with the usual fields.
  await ctx.wakeLog.blocked(row, reason);
  await notice(ctx, row.conversationId, reason);
}

/** The outcome of a run that already existed under the same dedupe key. */
function outcomeOf(w: WakeRow): WakeOutcome {
  if (w.status === "blocked" && w.blockReason) return { ok: false, reason: w.blockReason };
  if (w.status === "dropped") return { ok: false, reason: "gone" };
  return { ok: true, wakeId: w.id };
}
