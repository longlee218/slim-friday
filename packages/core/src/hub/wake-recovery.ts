import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";

/**
 * At start, check the queued runs the last boot left: a run that waited over `wakeExpireMs` is expired, one
 * whose bot or conversation is gone is dropped, the rest get their caps checked and are released (`admit`).
 * `leased` and `running` rows are left to the claimer: it reclaims rows of an older boot and counts the cut.
 */
export async function recoverWakes(ctx: HubContext): Promise<void> {
  const { store, clock } = ctx.deps;
  const now = clock.now();
  for (const r of await store.wakes.open()) {
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
