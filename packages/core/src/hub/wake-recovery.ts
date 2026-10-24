import type { WakeRow } from "../domain/wake";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";
import { placeInScope } from "./wake-admission";

/**
 * At start, check the queued runs the last boot left: a run that waited over `wakeExpireMs` is expired, one
 * whose bot or conversation is gone is dropped, the rest get their caps checked and are released (`admit`).
 * First start of the new build: a `running` row with no lease owner was left by the previous build. It keeps
 * its status, so the claimer takes it as a cut (cuts + 1, the bot is told it was interrupted, and the third
 * cut ends it as `interrupted`), but it first gets the scope key and priority the claimer needs. Rows of the
 * new build (`leased`, or `running` with an owner) are left to the claimer, which reclaims rows of an older
 * boot. Each row is fixed once: later boots find the scope and priority already right.
 */
export async function recoverWakes(ctx: HubContext): Promise<void> {
  const { store, clock } = ctx.deps;
  const now = clock.now();
  const open = await store.wakes.open();
  // Old `running` rows first: admitting a queued row hints the claimers, which may take them at once.
  for (const r of open) {
    if (r.status === "running" && r.leaseOwner === undefined) await recoverOldRunning(ctx, r);
  }
  for (const r of open) {
    if (r.status !== "queued") continue;
    const bot = await store.bots.get(r.targetBot);
    const conv = await store.conversations.get(r.conversationId);
    if (!bot || !conv) {
      await ctx.wakeLog.dropped(r.id);
      continue;
    }
    if (now - r.createdAt > ctx.limits.wakeExpireMs) {
      await ctx.wakeLog.expired(r.id);
      await tell(
        ctx,
        r.conversationId,
        `A message for ${bot.name} expired while the app was down and was not delivered.`,
      );
      continue;
    }
    ctx.wakeLog.redelivered(r);
    // One bad row must not strand the rest.
    try {
      await ctx.admit(r, bot, { ...(r.hop > ctx.limits.maxHops && { exemptFromHops: true }) });
    } catch (err) {
      ctx.deps.log?.error({ error: errText(err), wakeId: r.id }, "hub.recover_failed");
      await ctx.wakeLog.dropped(r.id).catch(() => {});
    }
  }
}

/** A `running` row of the previous build: place it in its scope, or drop it when its bot or conversation is gone. */
async function recoverOldRunning(ctx: HubContext, r: WakeRow): Promise<void> {
  const bot = await ctx.deps.store.bots.get(r.targetBot);
  try {
    if (!bot || !(await placeInScope(ctx, r, bot))) await ctx.wakeLog.dropped(r.id);
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), wakeId: r.id }, "hub.recover_failed");
  }
}
