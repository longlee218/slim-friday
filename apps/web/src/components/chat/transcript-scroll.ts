import type { TranscriptItem } from "./transcript-items";

/** Distance (px) from the top at which the next older page is requested. */
export const LOAD_OLDER_PX = 400;
/** Distance (px) from the bottom within which new items keep the view following. */
export const FOLLOW_PX = 80;

/** True when a scroller is within `px` of its bottom. */
export function nearBottom(el: HTMLElement, px = FOLLOW_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= px;
}

/**
 * New scrollTop after older messages were added above the view: the content grew by
 * `nextHeight - prevHeight`, so the offset moves by the same amount and the message the
 * owner was reading stays where it was. `top` is the offset right now (the owner may have
 * scrolled since the page was requested).
 */
export function anchoredScrollTop(top: number, prevHeight: number, nextHeight: number): number {
  return top + (nextHeight - prevHeight);
}

/**
 * What the view does when its content changes: `open` pins to the newest row once (and
 * again after a moment), `follow` pins because the owner is at the bottom (a row was added
 * or a live run / last row grew), `stay` leaves the scroll alone.
 */
export function pinAction(s: { started: boolean; hasRows: boolean; following: boolean }) {
  if (!s.hasRows) return "stay";
  if (!s.started) return "open";
  return s.following ? "follow" : "stay";
}

/** Key of the newest message still being sent by the owner; a new one means the owner just sent (or replied). */
export function sendingKey(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "message" && it.pending === "sending") return it.key;
  }
  return undefined;
}
