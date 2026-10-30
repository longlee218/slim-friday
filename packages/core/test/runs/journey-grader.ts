import type { InboundTurn } from "../../src";

/**
 * Journey check: the bot can see `text` this turn, either in the system prompt its session was opened with or in
 * the turn's `<state_changed>` block. Throws (naming both places) when it is in neither.
 */
export function expectTurnShows(turn: InboundTurn, systemPrompt: string, text: string): void {
  if (systemPrompt.includes(text) || turn.stateChanged?.includes(text)) return;
  throw new Error(
    `expected the turn to show ${JSON.stringify(text)}, but it is in neither the system prompt nor stateChanged`,
  );
}
