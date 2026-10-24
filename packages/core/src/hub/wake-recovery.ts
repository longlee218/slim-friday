import type { WakeRow } from "../domain/wake";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";

/**
 * At start, put back what the last run left open. A queued wake is sent as it was (unless it waited over a day:
 * expired); a running one is sent once more with a note that its turn was cut (a second cut: interrupted); a wake
 * whose bot or conversation is gone is dropped.
 */
export async function recoverWakes(ctx: HubContext): Promise<void> {
  const { store, clock } = ctx.deps;
  const now = clock.now();
  const open = await store.wakes.open();
  for (const r of open) {
    const bot = await store.bots.get(r.targetBot);
    const conv = await store.conversations.get(r.conversationId);
    if (!bot || !conv) {
      await ctx.wakeLog.dropped(r.id);
      continue;
    }
    if (r.status === "queued" && now - r.createdAt > ctx.limits.wakeExpireMs) {
      await ctx.wakeLog.expired(r.id);
      await tell(
        ctx,
        r.conversationId,
        `A message for ${bot.name} expired while the app was down and was not delivered.`,
      );
      continue;
    }
    const cut = r.status === "running";
    if (cut && r.attempts >= 2) {
      await ctx.wakeLog.interrupted(r.id);
      await tell(
        ctx,
        r.conversationId,
        `${bot.name} was interrupted twice by restarts; the message was not delivered again.`,
      );
      continue;
    }
    const next: WakeRow = { ...r, status: "queued", attempts: cut ? r.attempts + 1 : r.attempts };
    await store.wakes.update(r.id, { status: "queued", attempts: next.attempts });
    ctx.wakeLog.redelivered(next);
    // One bad row (a vanished attachment, a session that will not open) must not strand the rest.
    try {
      await ctx.admit(next, bot, {
        ...(cut && { interrupted: true }),
        ...(r.hop > ctx.limits.maxHops && { exemptFromHops: true }),
      });
    } catch (err) {
      ctx.deps.log?.error({ error: errText(err), wakeId: r.id }, "hub.recover_failed");
      await ctx.wakeLog.dropped(r.id).catch(() => {});
    }
  }
}
