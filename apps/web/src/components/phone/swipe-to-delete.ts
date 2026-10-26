import { movedPastSlop } from "../chat/swipe-to-reply";

/** Width (px) of the revealed Delete button; also how far a row may slide left. */
export const ACTION_PX = 80;

/** Where a row swipe stands; `dx` is the clamped slide (-80..0). */
export interface RowSwipe {
  phase: "idle" | "pressing" | "swiping" | "cancelled";
  dx: number;
}

/**
 * Next state for a finger offset from the press point; `from` is where the row rested (-80 when
 * open). Vertical-first movement is a scroll and cancels for good; under the slop the row stays
 * put, so the drift of a tap never wiggles it. The slide is clamped to -80..0.
 */
export function rowSwipeStep(s: RowSwipe, move: { dx: number; dy: number }, from = 0): RowSwipe {
  if (s.phase === "idle" || s.phase === "cancelled") return s;
  if (s.phase === "pressing" && Math.abs(move.dy) > Math.abs(move.dx) && movedPastSlop(move)) {
    return { phase: "cancelled", dx: from };
  }
  if (s.phase === "pressing" && !movedPastSlop(move)) return { phase: "pressing", dx: from };
  return { phase: "swiping", dx: Math.max(-ACTION_PX, Math.min(0, from + move.dx)) };
}

/** True when a release at slide `dx` leaves the row open (at least half the button revealed). */
export function settlesOpen(dx: number): boolean {
  return dx <= -ACTION_PX / 2;
}
