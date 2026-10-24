import { useLayoutEffect, useRef, useState } from "react";
import { anchoredScrollTop, LOAD_OLDER_PX, nearBottom } from "./transcript-scroll";

/** Time after the first paint at which the view pins to the newest item again (diagrams grow the page). */
const REPIN_MS = 450;

export interface TranscriptScrollInput {
  scroller: HTMLElement | null;
  itemCount: number;
  /** Key of the newest row; a change means something was added at the end. */
  lastKey: string | undefined;
  /** Loaded pages; a change means an older page arrived. */
  pageCount: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder(): void;
}

/**
 * Scroll behaviour of the transcript: open on the newest row (and again after 450 ms unless
 * the owner scrolled), follow new rows only within 80 px of the bottom, and when an older
 * page loads (within 400 px of the top) keep the message being read in place.
 */
export function useTranscriptScroll(i: TranscriptScrollInput) {
  const { scroller, itemCount, lastKey, pageCount } = i;
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const touched = useRef(false);
  const started = useRef(false);
  const anchor = useRef<{ top: number; height: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the newest row changes
  useLayoutEffect(() => {
    if (!scroller || itemCount === 0) return;
    const pin = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };
    if (!started.current) {
      started.current = true;
      pin();
      const t = setTimeout(() => {
        if (!touched.current) pin();
      }, REPIN_MS);
      return () => clearTimeout(t);
    }
    if (following.current) pin();
  }, [scroller, lastKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a page is added
  useLayoutEffect(() => {
    if (!scroller || !anchor.current) return;
    const a = anchor.current;
    anchor.current = null;
    scroller.scrollTop = anchoredScrollTop(a.top, a.height, scroller.scrollHeight);
  }, [scroller, pageCount]);

  return {
    atBottom,
    /** The owner scrolled by hand: the 450 ms re-pin must not fight them. */
    markTouched() {
      touched.current = true;
    },
    onScroll() {
      if (!scroller) return;
      following.current = nearBottom(scroller);
      setAtBottom(following.current);
      if (scroller.scrollTop < LOAD_OLDER_PX && i.hasOlder && !i.loadingOlder) {
        // Remember where we were; the layout effect above restores it once the page is in.
        anchor.current = { top: scroller.scrollTop, height: scroller.scrollHeight };
        i.loadOlder();
      }
    },
  };
}
