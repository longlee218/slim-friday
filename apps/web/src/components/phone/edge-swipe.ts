import { type RefObject, useEffect, useRef } from "react";

/** The swipe starts only within this many px of the left edge. */
const EDGE_PX = 24;
/** Fraction of the width the finger must travel for the release to pop. */
const POP_FRACTION = 0.33;
/** How far the view underneath sits left of its place at rest (percent of the width). */
const UNDER_SHIFT = 28;

/** True when a pointer went down close enough to the left edge. */
export const edgeSwipeStart = (x: number): boolean => x <= EDGE_PX;

/** True when a release after dragging `dx` px on a `width` px screen pops the view. */
export const edgeSwipePop = (dx: number, width: number): boolean => dx > width * POP_FRACTION;

/**
 * iOS edge swipe back on the `.ios` root: the pushed view follows the finger while the one under
 * it slides from -28% to 0, with no transition (`.dragging`, also under Reduce Motion). A release
 * past a third of the width calls `onPop`; a shorter one lets CSS settle both views back.
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
    let views: HTMLElement[] = [];

    const settle = () => {
      for (const v of views) {
        v.style.transform = "";
        v.classList.remove("dragging");
      }
      views = [];
    };
    const down = (e: PointerEvent) => {
      if (!edgeSwipeStart(e.clientX)) return;
      const all = [...el.querySelectorAll<HTMLElement>(".ios-view")].filter(
        (v) => !v.classList.contains("leave"),
      );
      if (all.length < 2) return;
      views = all.slice(-2);
      x0 = e.clientX;
      dx = 0;
    };
    const move = (e: PointerEvent) => {
      if (x0 === null) return;
      const width = el.clientWidth || window.innerWidth;
      dx = Math.max(0, e.clientX - x0);
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
      settle();
      if (pops) pop.current();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      settle();
    };
  }, [root, enabled]);
}
