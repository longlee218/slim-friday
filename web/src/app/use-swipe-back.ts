import { type RefObject, useEffect } from "react";

/** Horizontal travel (px) before the swipe takes over from scrolling. */
const ENGAGE = 12;
/** Release past this share of the width, or faster than FLICK px/ms, goes back. */
const COMMIT = 0.35;
const FLICK = 0.5;
/** The list sits this far left under the chat and slides into place (iOS parallax). */
const UNDER = -30;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * Phone back gesture: a rightward drag anywhere on the chat screen moves it with
 * the finger and reveals the chat list underneath. A leftward drag is left alone:
 * that is swipe-to-reply on a message. Text fields never start the gesture.
 * `under` is the list element; the window gets `data-swiping` while it is visible.
 */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  under: () => HTMLElement | null,
  enabled: boolean,
  onBack: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const win = el.parentElement;
    let start: { x: number; y: number } | null = null;
    let last = { x: 0, t: 0 };
    let speed = 0;
    let active = false;
    let list: HTMLElement | null = null;

    const place = (dx: number) => {
      el.style.transform = `translateX(${dx}px)`;
      if (list) list.style.transform = `translateX(${UNDER * (1 - dx / el.offsetWidth)}%)`;
    };
    const reset = () => {
      el.style.transform = "";
      if (list) list.style.transform = "";
      if (win) delete win.dataset.swiping;
      active = false;
      list = null;
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || (e.target as HTMLElement).closest("input, textarea")) return;
      start = { x: e.clientX, y: e.clientY };
      last = { x: e.clientX, t: e.timeStamp };
      speed = 0;
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!active) {
        // Mostly vertical: it is a scroll, stop watching this touch.
        if (Math.abs(dy) > ENGAGE && Math.abs(dy) > Math.abs(dx)) start = null;
        if (!start || dx < ENGAGE || dx < Math.abs(dy) * 1.5) return;
        active = true;
        list = under();
        if (win) win.dataset.swiping = "";
      }
      // One frame minimum, so two events in the same instant never read as a flick.
      speed = (e.clientX - last.x) / Math.max(16, e.timeStamp - last.t);
      last = { x: e.clientX, t: e.timeStamp };
      place(Math.max(0, dx));
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const dx = Math.max(0, e.clientX - start.x);
      start = null;
      if (!active) return;
      // A finger that rested before lifting is not a flick.
      const flick = speed > FLICK && e.timeStamp - last.t < 100;
      const back = e.type === "pointerup" && (dx > el.offsetWidth * COMMIT || flick);
      const to = back ? el.offsetWidth : 0;
      const opts = { duration: back ? 260 : 320, easing: EASE, fill: "forwards" as const };
      list?.animate([{ transform: list.style.transform }, { transform: `translateX(${back ? 0 : UNDER}%)` }], opts);
      const anim = el.animate([{ transform: el.style.transform }, { transform: `translateX(${to}px)` }], opts);
      anim.finished.then(() => {
        if (back) onBack();
        // After React has hidden the chat screen, drop the inline styles and held animations.
        requestAnimationFrame(() => {
          for (const a of [...el.getAnimations(), ...(list?.getAnimations() ?? [])]) a.cancel();
          reset();
        });
      });
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
      reset();
    };
  }, [ref, under, enabled, onBack]);
}
