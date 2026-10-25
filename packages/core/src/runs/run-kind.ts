import type { WakeRow } from "../domain/wake";
import { CONTINUATION_KEY } from "./run-steering";

/**
 * What started a run, which decides its reply guidance, its tool set and whether it may stay silent:
 * `owner` (an owner message, a continuation or a card resume), `bot` (another bot's message), `ticket`
 * (a ticket wake) or `intro` (the first hidden run of a new bot).
 */
export type RunKind = "owner" | "bot" | "ticket" | "intro";

/** The kind of a run: the intro flag first, then the ticket, then a bot sender; everything else is the owner's. */
export function runKindOf(row: WakeRow): RunKind {
  if (row.intro) return "intro";
  if (row.ticketId) return "ticket";
  if (row.sender.kind === "bot") return "bot";
  return "owner";
}

/**
 * True when the run may end with no reply (`NO_RESPONSE`): a ticket run, or a bot's `fyi` that is not a reply
 * to a request (no `parentWakeId`). An owner message, a continuation, a card resume and a bot result never may.
 * A row with a `cardId` resumes on the owner's card answer (its turn is not the wake's first), so it is an owner
 * turn whatever started the run (spec §6.3). Decision (spec §6.12 vs §6.3): a ticket run that parked on a card and
 * was answered by the owner is a run the owner took part in, so its empty final posts `done.` in the direct chat;
 * a ticket run that never involved the owner stays silent.
 */
export function silenceAllowed(row: WakeRow, kind: RunKind): boolean {
  if (row.cardId !== undefined) return false;
  if (kind === "ticket") return true;
  return kind === "bot" && row.intent === "fyi" && row.parentWakeId === undefined;
}

/**
 * True when the run's answer is for the owner: an owner run, a run resumed by the owner's card answer
 * (`cardId`), or a bot-sent run that must reach the owner: a `result` / `status` (relayed to the owner, spec
 * §6.3) or a hand-off (the receiver posts the stage's result in the group). Ticket, intro and bot-to-bot
 * `request` / `question` / `fyi` runs are not, so they raise no finished notice and no unread. The store's unread
 * query (`readRepo`, `quietWakes`) applies the same rule in SQL; a store test keeps both in agreement.
 */
export function talksToOwner(row: WakeRow): boolean {
  if (row.cardId !== undefined) return true;
  const kind = runKindOf(row);
  if (kind === "owner") return true;
  return (
    kind === "bot" && (row.handoff === true || row.intent === "result" || row.intent === "status")
  );
}

/**
 * True when the turn's text comes from Friday rather than from its sender: a continuation run, a run resumed
 * with a card's answer (`resumed`), or a system sender. Such a turn is labelled as automated.
 */
export function isAutomatedTurn(row: WakeRow, resumed: boolean): boolean {
  return (
    resumed ||
    row.sender.kind === "system" ||
    (row.dedupeKey?.startsWith(CONTINUATION_KEY) ?? false)
  );
}
