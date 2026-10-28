import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { anchoredScrollTop, LOAD_OLDER_PX, nearBottom, pinAction } from "./transcript-scroll";

/** Time after the first paint at which the view pins to the newest item again (diagrams grow the page). */
const REPIN_MS = 450;

export interface TranscriptScrollInput {
  scroller: HTMLElement | null;
  itemCount: number;
  /** Key of the newest row; a change means something was added at the end. */
  lastKey: string | undefined;
  /** Key of the newest message the owner is sending (`sendingKey`); a new one pins wherever the view was. */
  sentKey: string | undefined;
  /** Height of the whole list (`virtualizer.getTotalSize()`); it grows with a live run or a measured row. */
  totalSize: number;
  /** Loaded pages; a change means an older page arrived. */
  pageCount: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder(): void;
}

/**
 * Scroll behaviour of the transcript: open on the newest row (and again after 450 ms unless
 * the owner scrolled), follow new rows only within 80 px of the bottom, jump to the bottom when the
 * owner sends, and when an older page loads (within 400 px of the top) keep the message being read
 * in place.
 */
export function useTranscriptScroll(i: TranscriptScrollInput) {
  const { scroller, itemCount, lastKey, totalSize, pageCount } = i;
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const touched = useRef(false);
  const started = useRef(false);
  /** scrollHeight when an older page was requested. */
  const anchor = useRef<number | null>(null);

  const hasRows = itemCount > 0;
  const pin = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  // Open on the newest row, and once more after 450 ms (unless the owner scrolled).
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once, when rows first exist
  useLayoutEffect(() => {
    if (!scroller || pinAction({ started: started.current, hasRows, following: true }) !== "open") {
      return;
    }
    started.current = true;
    pin();
    const t = setTimeout(() => {
      if (!touched.current) pin();
    }, REPIN_MS);
    return () => clearTimeout(t);
  }, [scroller, hasRows]);

  // Follow: a new row, or the list growing (live run steps, a card under the last row).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the end or the size changes
  useLayoutEffect(() => {
    if (
      pinAction({ started: started.current, hasRows, following: following.current }) === "follow"
    ) {
      pin();
    }
  }, [scroller, lastKey, totalSize]);

  // The owner sent (or replied from far up): show their message and follow the answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a new send appears
  useLayoutEffect(() => {
    if (!i.sentKey || !started.current) return;
    following.current = true;
    setAtBottom(true);
    pin();
  }, [scroller, i.sentKey]);

  // Older page arrived: move by the height that was added above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a page is added
  useLayoutEffect(() => {
    if (!scroller || !anchor.current) return;
    const height = anchor.current;
    anchor.current = null;
    scroller.scrollTop = anchoredScrollTop(scroller.scrollTop, height, scroller.scrollHeight);
  }, [scroller, pageCount]);

  // A fetch that ended without a page (failure, nothing new) must not leave a stale anchor.
  useEffect(() => {
    if (!i.loadingOlder) anchor.current = null;
  }, [i.loadingOlder]);

  return {
    atBottom,
    /** Glide to the newest row and follow again. */
    toLatest() {
      if (!scroller) return;
      following.current = true;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    },
    /** The owner scrolled by hand: the 450 ms re-pin must not fight them. */
    markTouched() {
      touched.current = true;
    },
    onScroll() {
      if (!scroller) return;
      following.current = nearBottom(scroller);
      setAtBottom(following.current);
      if (
        scroller.scrollTop < LOAD_OLDER_PX &&
        i.hasOlder &&
        !i.loadingOlder &&
        anchor.current === null
      ) {
        // Remember the height; the layout effect above shifts by what the page adds.
        anchor.current = scroller.scrollHeight;
        i.loadOlder();
      }
    },
  };
}
