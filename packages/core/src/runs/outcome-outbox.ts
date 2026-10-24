import type { WakeIntent, WakeRow, WakeStatus } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { sha256Hex } from "../permission/input-hash";
import { clampBotMessage, nextHop } from "../routing/bot-messages";
import { createRun } from "./run-create";

/** The dedupe key of the automatic outcome of run `wakeId`: a second delivery finds the first run. */
export const outcomeKey = (wakeId: string): string => `auto-outcome:${wakeId}`;

/**
 * The dedupe key of one tool send (`SendToBot` / `HandOff`) made while run `wakeId` answers. `n` counts the
 * identical sends of one execution of the run, so the same call made again after a cut (a re-run counts from 1
 * again) finds the first send, and two deliberate identical sends in one execution get different keys.
 * Async because the hash uses Web Crypto (core cannot import node:crypto).
 */
export async function sendKeyFor(
  wakeId: string,
  to: string,
  intent: WakeIntent,
  text: string,
  n: number,
): Promise<string> {
  return `send:${wakeId}:${await sha256Hex(`${to}|${intent}|${text}`)}:${n}`;
}

/** Why a run that ended without an answer gives no text of its own (the line after "Could not complete..."). */
const WHY: Partial<Record<WakeStatus, string>> = {
  failed: "it failed",
  interrupted: "it was interrupted by restarts",
  cancelled: "the owner stopped it",
  expired: "it waited too long to start",
  dropped: "the bot or the conversation is gone",
};

/** What goes back for a finished run: its result, or the failure status; undefined when there is nothing. */
function outcomeOf(row: WakeRow): { intent: WakeIntent; text: string } | undefined {
  if (row.status === "done") {
    const text = clampBotMessage(row.resultText ?? "");
    return text ? { intent: "result", text } : undefined;
  }
  const why = row.error ?? WHY[row.status];
  if (!why) return undefined;
  return { intent: "status", text: `Could not complete the delegated request: ${why}` };
}

/**
 * Return the outcome of a finished run to the bot that sent it the work. Only a run woken by a bot with intent
 * request or question, not a hand-off, not a ticket wake, in a group chat, returns anything (the others are
 * not selected by the reconciler, or are marked returned at once). A run that already sent that bot an explicit `result` sends nothing more. The delivery is
 * a run for the sender stored under `outcomeKey`, so a repeat (the reconciler after a crash, or a second call)
 * never creates a second one. A sender that is gone or capped leaves a dropped or blocked row under the same
 * key; a retry would find it, so that counts as delivered (logged). `outcomeReturnedAt` is set only when the
 * outcome was delivered or there was nothing to send. Throws when the store fails; the caller retries.
 */
export async function returnOutcome(ctx: HubContext, row: WakeRow): Promise<boolean> {
  const { store, clock, log } = ctx.deps;
  const sender = row.sender;
  if (sender.kind !== "bot" || row.handoff) return true;
  if (row.intent !== "request" && row.intent !== "question") return true;
  if (row.outcomeReturnedAt !== undefined) return true;
  const markReturned = async () => {
    await store.wakes.update(row.id, { outcomeReturnedAt: clock.now() });
    return true;
  };
  // A ticket wake is not a delegation (its sender reads the ticket), and bots message each other in groups only.
  const conv = await store.conversations.get(row.conversationId);
  if (row.ticketId || conv?.kind !== "group") return markReturned();
  const out = outcomeOf(row);
  if (!out) return markReturned();
  // The explicit result is read from the stored rows, so it counts after a restart too.
  const since = row.startedAt ?? row.createdAt;
  const sent = await store.wakes.botSentSince(row.conversationId, since);
  const explicit = sent.some(
    (w) =>
      w.intent === "result" &&
      w.parentWakeId === row.id &&
      w.targetBot === sender.botId &&
      w.sender.kind === "bot" &&
      w.sender.botId === row.targetBot,
  );
  if (explicit) return markReturned();
  const res = await createRun(ctx, {
    botId: sender.botId,
    conversationId: row.conversationId,
    sender: { kind: "bot", botId: row.targetBot },
    text: out.text,
    hop: nextHop(row.hop),
    opts: {
      intent: out.intent,
      chainId: row.chainId,
      parentWakeId: row.id,
      exemptFromHops: true,
    },
    dedupeKey: outcomeKey(row.id),
  });
  if (!res.ok) log?.warn({ wakeId: row.id, reason: res.reason }, "hub.result_not_returned");
  return markReturned();
}

/** `returnOutcome` for the end of a run: a failure is logged, never thrown (the reconciler tries again). */
export async function returnOutcomeSafe(ctx: HubContext, row: WakeRow): Promise<void> {
  try {
    await returnOutcome(ctx, row);
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), wakeId: row.id }, "hub.outcome_return_failed");
  }
}
