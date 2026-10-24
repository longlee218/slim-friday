import { type RefObject, useEffect, useRef } from "react";

/** The swipe starts only within this many px of the left edge. */
const EDGE_PX = 24;
/** Fraction of the width the finger must travel for the release to pop. */
const POP_FRACTION = 0.33;
/** A move this far up or down before sideways cancels the swipe. */
const VERTICAL_PX = 8;
/** How far the view underneath sits left of its place at rest (percent of the width). */
const UNDER_SHIFT = 28;

/** True when a pointer went down close enough to the left edge. */
export const edgeSwipeStart = (x: number): boolean => x <= EDGE_PX;

/** True when a release after dragging `dx` px on a `width` px screen pops the view. */
export const edgeSwipePop = (dx: number, width: number): boolean => dx > width * POP_FRACTION;

/**
 * iOS edge swipe back on the `.ios` root: the pushed view follows the finger while the one under
 * it slides from -28% to 0, with no transition (`.dragging`, also under Reduce Motion). A release
 * past a third of the width calls `onPop` (a cancelled pointer never pops); a shorter
 * one lets CSS settle both views back. A vertical-first move cancels the gesture (it is a scroll).
 */
export function useEdgeSwipe(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  onPop: () => void,
): void {
  const pop = useRef(onPop);
  pop.current = onPop;

  useEffect(() => {
    const el = root.current;
    if (!el || !enabled) return;
    let x0: number | null = null;
    let dx = 0;
    let y0 = 0;
    let views: HTMLElement[] = [];

    /**
     * Ends the drag. Not popping: clear the inline transform so CSS animates the views back.
     * Popping: keep the dragged position until the `.leave` class is on (next frame), so the
     * top view slides out from where the finger left it instead of jumping back first.
     */
    const settle = (popping: boolean) => {
      const done = views;
      views = [];
      for (const v of done) v.classList.remove("dragging");
      const clear = () => {
        for (const v of done) v.style.transform = "";
      };
      if (popping) requestAnimationFrame(clear);
      else clear();
    };
    const down = (e: PointerEvent) => {
      if (!edgeSwipeStart(e.clientX)) return;
      const all = [...el.querySelectorAll<HTMLElement>(".ios-view")].filter(
        (v) => !v.classList.contains("leave"),
      );
      if (all.length < 2) return;
      views = all.slice(-2);
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
    };
    const move = (e: PointerEvent) => {
      if (x0 === null) return;
      const width = el.clientWidth || window.innerWidth;
      const rawDx = e.clientX - x0;
      const dy = Math.abs(e.clientY - y0);
      // Vertical first: it is a scroll, not a back swipe.
      if (dx === 0 && dy > Math.abs(rawDx) && dy > VERTICAL_PX) {
        x0 = null;
        settle(false);
        return;
      }
      dx = Math.max(0, rawDx);
      const [under, top] = views;
      top.classList.add("dragging");
      under.classList.add("dragging");
      top.style.transform = `translateX(${dx}px)`;
      under.style.transform = `translateX(${-UNDER_SHIFT + (dx / width) * UNDER_SHIFT}%)`;
    };
    const up = () => {
      if (x0 === null) return;
      const pops = edgeSwipePop(dx, el.clientWidth || window.innerWidth);
      x0 = null;
      settle(pops);
      if (pops) pop.current();
    };
    // The browser took the pointer (scroll, system gesture): reset, never pop.
    const cancel = () => {
      if (x0 === null) return;
      x0 = null;
      settle(false);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      settle(false);
    };
  }, [root, enabled]);
}
