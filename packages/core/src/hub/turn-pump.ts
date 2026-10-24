import { returnOutcome } from "./bot-messaging";
import { pumpEvents } from "./event-pump";
import { type HubContext, tell } from "./hub-context";
import { errText } from "./hub-types";
import type { PoolEntry } from "./session-pool";
import { checkUnfinished } from "./ticket-wakes";
import { dispatch } from "./turn-dispatch";

/** Run the event loop of one session: collect the bot's text, close each turn, handle a closed session. */
export function startPump(ctx: HubContext, entry: PoolEntry): Promise<void> {
  return pumpEvents(entry, ctx.deps, {
    onBotText: async (e, text) => {
      // Text goes to the channel only; a bot reaches another bot with SendToBot / HandOff.
      e.turnTexts.push(text);
      if (e.currentWakeId) await ctx.wakeLog.firstText(e.currentWakeId);
    },
    onTurnEnd: async (e) => {
      // The pump cleared `busy`; hold it until this wake is closed and the queue is drained, so a wake that arrives
      // meanwhile (or the re-wake below) waits in the queue instead of starting a second turn.
      e.busy = true;
      const wakeId = e.currentWakeId;
      await returnOutcome(ctx, e);
      if (wakeId) await ctx.wakeLog.done(wakeId);
      e.currentWakeId = undefined;
      await checkUnfinished(ctx, e);
      // A queued message that cannot be sent is reported; the next one still gets its turn.
      for (;;) {
        const next = e.queue.shift();
        if (!next) {
          e.busy = false;
          break;
        }
        try {
          await dispatch(ctx, e, next);
          break;
        } catch (err) {
          e.busy = true; // keep the claim while the failure is reported
          const why = errText(err);
          ctx.deps.log?.error({ error: why, botId: e.bot.id }, "hub.dispatch_failed");
          await tell(ctx, next.conversationId, `Could not deliver the message: ${why}`);
        }
      }
    },
    onClosed: async (e, crashed, reason) => {
      if (ctx.pool.entry(e.key) === e) ctx.pool.remove(e.key);
      // The turn that was running ends here, and the messages that waited behind it are not delivered.
      if (e.currentWakeId) await ctx.wakeLog.interrupted(e.currentWakeId);
      e.currentWakeId = undefined;
      for (const q of e.queue) await ctx.wakeLog.dropped(q.wakeId);
      e.queue = [];
      if (!crashed) return;
      // A crashed session must not stay alive next to the one the next message resumes.
      e.stopping = true;
      await e.session
        .stop()
        .catch((err) =>
          ctx.deps.log?.error({ error: errText(err), botId: e.bot.id }, "hub.stop_failed"),
        );
      await tell(
        ctx,
        e.current.conversationId,
        `${e.bot.name} stopped unexpectedly${reason ? `: ${reason}` : ""}. Send a message to continue.`,
      );
    },
  });
}
