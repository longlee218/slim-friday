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
 * turn whatever started the run (spec §6.3).
 */
export function silenceAllowed(row: WakeRow, kind: RunKind): boolean {
  if (row.cardId !== undefined) return false;
  if (kind === "ticket") return true;
  return kind === "bot" && row.intent === "fyi" && row.parentWakeId === undefined;
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
