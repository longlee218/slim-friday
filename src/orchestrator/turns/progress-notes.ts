import { redactClip } from "../../observability/redact";

/* The latest thing the running agent said, per turn: an in-memory port (no db). The stream consumer feeds it with
   each assistant message that has text; the status snapshot reads it ("what is it doing now?"); the run clears it when
   it ends, so the map only holds running turns. */

/** Longest note kept (chars, after redaction). */
export const PROGRESS_NOTE_MAX = 200;

/** turnId -> latest progress note (redacted, clipped). */
const notes = new Map<string, string>();

/** Remember the latest assistant text of a turn (redacted and clipped here: no caller can store a raw secret). */
export function setProgressNote(turnId: string, text: string): void {
  notes.set(turnId, redactClip(text.replace(/\s+/g, " ").trim(), PROGRESS_NOTE_MAX));
}

/** The latest note of a turn, or undefined (none yet, or the run ended). */
export const getProgressNote = (turnId: string): string | undefined => notes.get(turnId);

/** Forget a turn's note (its run ended). */
export function clearProgressNote(turnId: string): void {
  notes.delete(turnId);
}
