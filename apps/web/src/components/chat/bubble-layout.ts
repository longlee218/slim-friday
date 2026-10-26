import type { TranscriptItem } from "./transcript-items";

/** Consecutive messages of one author further apart than this start a new run. */
export const RUN_GAP_MS = 5 * 60 * 1000;

/** Where a message sits in a run of consecutive messages from one author. */
export interface RunPlace {
  /** First of its run: the bot's name shows above it (in groups). */
  head: boolean;
  /** Last of its run: the face and the time show beside and under it. */
  tail: boolean;
}

/** Author of a row that joins runs: "u" for the owner, "b:<id>" for a bot; cards and lines join none. */
function authorOf(item: TranscriptItem): string | undefined {
  if (item.kind === "run") return `b:${item.run.botId}`;
  if (item.kind !== "message") return undefined;
  const m = item.message;
  if (m.kind === "relay" || m.author.kind === "system") return undefined;
  return m.author.kind === "user" ? "u" : `b:${m.author.botId}`;
}

/** Time apart, for the run gap; a live run is "now" and always joins the message before it. */
const gapOf = (a: TranscriptItem, b: TranscriptItem): number =>
  a.kind === "message" && b.kind === "message" ? Math.abs(b.message.at - a.message.at) : 0;

/**
 * Messenger grouping: adjacent rows of one author (within `RUN_GAP_MS`) form a run. Sets
 * `head` and `tail` on every message and live-run row; other rows break a run.
 */
export function markRuns(items: TranscriptItem[]): void {
  items.forEach((item, i) => {
    if (item.kind !== "message" && item.kind !== "run") return;
    const who = authorOf(item);
    const joins = (other: TranscriptItem | undefined) =>
      !!other && !!who && authorOf(other) === who && gapOf(item, other) <= RUN_GAP_MS;
    item.place = { head: !joins(items[i - 1]), tail: !joins(items[i + 1]) };
  });
}

/** A fenced block (code, diagram) or a table separator row: content that needs the full column. */
const BLOCK = /^\s{0,3}(```|~~~)|^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

/**
 * A bot answer holding block content (code, tables, diagrams) drops the bubble fill and takes
 * the full column, so wide content reads on the pane; plain answers stay grey bubbles.
 */
export function isRichText(text: string): boolean {
  return BLOCK.test(text);
}
