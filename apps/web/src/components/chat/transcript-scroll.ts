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
 * `nextHeight - prevHeight`, so the offset grows by the same amount and the message the
 * owner was reading stays where it was.
 */
export function anchoredScrollTop(prevTop: number, prevHeight: number, nextHeight: number): number {
  return prevTop + (nextHeight - prevHeight);
}
