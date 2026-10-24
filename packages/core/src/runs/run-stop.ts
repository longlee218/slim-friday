import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { GroupId } from "../domain/group";
import type { WakeRow, WakeStatus } from "../domain/wake";
import { type HubContext, tell } from "../hub/hub-context";
import { withdrawCards } from "./run-card-withdraw";

/** What a stop acts on: a bot (all its scopes, or one), every member scope of a group, or one conversation. */
export type StopTarget =
  | { botId: BotId; only?: "direct" | GroupId }
  | { groupId: GroupId }
  | { conversationId: ConversationId };

/** Why the runs end and what the conversation is told; the default is the owner's Stop. */
export interface StopReason {
  /** Stored as the run's `error`. */
  error: string;
  /** The notice for a conversation; gets the bot's name. */
  notice: (botName: string) => string;
  /** Tell every conversation that lost a run; unset: only those where a bot delegated the work. */
  always?: boolean;
}

/** The owner's Stop. */
const OWNER_STOP: StopReason = {
  error: "Stopped by the owner.",
  notice: (name) => `Stopped by the owner: the request to ${name} was cancelled.`,
};

/** Statuses a stop may cancel: not started, held by a worker, or parked on a card. */
const ACTIVE: WakeStatus[] = ["queued", "leased", "running", "waiting_input"];

/** Tries to cancel a row whose fence moves under us (a worker claims it between the read and the write). */
const TRIES = 3;

/** The active runs a target names, oldest first. */
async function activeRuns(ctx: HubContext, t: StopTarget): Promise<WakeRow[]> {
  const { store } = ctx.deps;
  if ("groupId" in t) return store.wakes.activeOfGroup(t.groupId);
  if ("conversationId" in t) {
    const conv = await store.conversations.get(t.conversationId);
    if (!conv) return [];
    return activeRuns(
      ctx,
      conv.kind === "direct" ? { botId: conv.botId, only: "direct" } : { groupId: conv.groupId },
    );
  }
  const rows = await store.wakes.activeOfBot(t.botId);
  const { only } = t;
  if (!only) return rows;
  // A group scope key is `<botId>@<groupId>`; a direct one has no `@`.
  return rows.filter((w) =>
    only === "direct" ? !w.scopeKey.includes("@") : w.scopeKey.endsWith(`@${only}`),
  );
}

/**
 * Cancel one run: the guarded transition is the commit point (nothing else in the store can end it after
 * this). The outcome counts as returned, so the delegating bot is not woken by the owner's decision.
 * Returns the cancelled row, or undefined when the run ended by itself first.
 */
async function cancelRun(
  ctx: HubContext,
  row: WakeRow,
  error: string,
): Promise<WakeRow | undefined> {
  const { store, clock } = ctx.deps;
  let cur: WakeRow | undefined = row;
  for (let i = 0; i < TRIES && cur && ACTIVE.includes(cur.status); i++) {
    const now = clock.now();
    const patch = { status: "cancelled" as const, error, endedAt: now, outcomeReturnedAt: now };
    if (await store.wakes.transition(cur.id, cur.leaseFence, ACTIVE, patch))
      return { ...cur, ...patch };
    cur = await store.wakes.get(cur.id);
  }
  return undefined;
}

/**
 * Stop the runs a target names, in this or any process. Order (crash safe, no cross-repo transaction): 1. each
 * queued, leased, running or parked run goes to `cancelled` through its fenced transition (the commit point;
 * a worker's later writes for it are refused); 2. the scope's steering is deleted and the runs' open cards
 * are withdrawn and closed on the surface; 3. the workers are hinted, and runs of this process are awaited.
 * A crash after step 1 is repaired by the reconciler (steering and cards of cancelled runs). A delegated
 * run in a group gets a notice in its conversation instead of an outcome for the delegating bot.
 */
export async function stopScope(
  ctx: HubContext,
  target: StopTarget,
  reason: StopReason = OWNER_STOP,
): Promise<{ stopped: number }> {
  const { store, clock } = ctx.deps;
  const cancelled: WakeRow[] = [];
  for (const row of await activeRuns(ctx, target)) {
    const done = await cancelRun(ctx, row, reason.error);
    if (done) cancelled.push(done);
  }
  const ids = new Set(cancelled.map((w) => w.id));
  for (const key of new Set(cancelled.map((w) => w.scopeKey))) {
    await store.steering.deleteForScope(key);
    await withdrawCards(
      ctx,
      (await store.cards.openForScope(key)).filter((c) => ids.has(c.wakeId)),
    );
  }
  for (const w of cancelled)
    if (w.startedAt !== undefined)
      await store.scopes.finished(w.scopeKey, clock.now(), Math.max(0, w.createdAt - 1));
  if (ids.size > 0) ctx.hints.cancel([...ids]);
  await noticeConversations(ctx, cancelled, reason);
  // Runs of this process end before the call returns (their sessions are stopped by the hint).
  await Promise.all([...ctx.runs.values()].filter((e) => ids.has(e.row.id)).map((e) => e.ended));
  return { stopped: cancelled.length };
}

/** One notice per conversation of work a bot delegated (the delegating bot reads it in the group), or of every run when `always`. */
async function noticeConversations(
  ctx: HubContext,
  cancelled: WakeRow[],
  reason: StopReason,
): Promise<void> {
  const seen = new Set<string>();
  for (const w of cancelled) {
    if ((!reason.always && w.sender.kind !== "bot") || seen.has(w.conversationId)) continue;
    seen.add(w.conversationId);
    const bot = await ctx.deps.store.bots.get(w.targetBot);
    await tell(ctx, w.conversationId, reason.notice(bot?.name ?? w.targetBot));
  }
}
