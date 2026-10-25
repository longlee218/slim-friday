import { useEffect, useRef } from "react";

/** Drag distance (px) past which a release replies. */
export const SWIPE_PX = 56;
/** Press-and-hold time (ms) that opens the message sheet. */
export const HOLD_MS = 450;
/** Delay (ms) before the press cue (slight shrink) shows. */
const CUE_MS = 150;
/** Furthest the message follows the finger (px). */
const MAX_DX = 80;
/** Movement (px) that cancels the hold and decides between swipe and scroll. */
const SLOP = 8;
/** Touches starting this close to the left edge belong to the back swipe. */
const EDGE_PX = 30;

/** Where a swipe gesture stands; `dx` is the clamped slide and `ok` means a release replies. */
export interface SwipeState {
  phase: "idle" | "pressing" | "swiping" | "cancelled";
  dx: number;
  ok: boolean;
}

/** True when the finger moved enough that a press-and-hold no longer counts. */
export function movedPastSlop(move: { dx: number; dy: number }): boolean {
  return Math.abs(move.dx) > SLOP || Math.abs(move.dy) > SLOP;
}

/**
 * Next state for a finger offset from the press point. Vertical-first movement means the
 * owner is scrolling, so the gesture is cancelled for good; once the message slid, vertical
 * drift is ignored. `dx` is clamped to 0..80 and `ok` is `dx > 56`.
 */
export function swipeStep(s: SwipeState, move: { dx: number; dy: number }): SwipeState {
  if (s.phase === "idle" || s.phase === "cancelled") return s;
  if (s.phase === "pressing" && Math.abs(move.dy) > Math.abs(move.dx) && Math.abs(move.dy) > SLOP) {
    return { phase: "cancelled", dx: 0, ok: false };
  }
  const dx = Math.max(0, Math.min(MAX_DX, move.dx));
  return {
    phase: s.phase === "swiping" || move.dx > SLOP ? "swiping" : "pressing",
    dx,
    ok: dx > SWIPE_PX,
  };
}

export interface SwipeHandlers {
  /** Released past the threshold on the bot message with this id. */
  onReply(messageId: number): void;
  /** Held for 450 ms on the bot message with this id. */
  onHold(messageId: number): void;
}

/**
 * Phone gesture on bot messages inside `el` (the scroller): swipe right to reply, press and
 * hold for the sheet. A bot message is a `.msg[data-mi]`; presses within 30 px of the left
 * edge and on buttons, links or inputs are ignored. Pass `null` to switch it off.
 */
export function useSwipeToReply(el: HTMLElement | null, handlers: SwipeHandlers): void {
  // Latest handlers without re-binding the listeners.
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    if (!el) return;
    let msg: HTMLElement | null = null;
    let start = { x: 0, y: 0 };
    let state: SwipeState = { phase: "idle", dx: 0, ok: false };
    let hold: ReturnType<typeof setTimeout> | undefined;
    let cue: ReturnType<typeof setTimeout> | undefined;

    /** Forgets the gesture; a message that slid springs back (240 ms). */
    const reset = () => {
      clearTimeout(hold);
      clearTimeout(cue);
      const m = msg;
      const slid = state.phase === "swiping";
      msg = null;
      state = { phase: "idle", dx: 0, ok: false };
      if (!m) return;
      // The press cue eases back by itself (transcript.css); a tap that never slid writes no inline style.
      m.classList.remove("swipe-ok", "holding");
      if (!slid) return;
      m.style.transition = "transform 240ms var(--ease)";
      m.style.transform = "";
      m.style.setProperty("--sw", "0");
      setTimeout(() => {
        m.style.transition = "";
      }, 260);
    };

    const down = (e: PointerEvent) => {
      const target = e.target as Element;
      if (e.clientX < EDGE_PX || target.closest("button, a, input, textarea")) return;
      const m = target.closest<HTMLElement>(".msg[data-mi]");
      if (!m) return;
      // A new press ends whatever the previous one left running.
      reset();
      msg = m;
      start = { x: e.clientX, y: e.clientY };
      state = { phase: "pressing", dx: 0, ok: false };
      // The press cue waits a moment so a tap or the start of a scroll never flashes it.
      cue = setTimeout(() => m.classList.add("holding"), CUE_MS);
      const id = Number(m.dataset.mi);
      hold = setTimeout(() => {
        reset();
        navigator.vibrate?.(10);
        h.current.onHold(id);
      }, HOLD_MS);
    };

    const move = (e: PointerEvent) => {
      if (!msg || state.phase === "idle") return;
      const delta = { dx: e.clientX - start.x, dy: e.clientY - start.y };
      if (movedPastSlop(delta)) {
        clearTimeout(hold);
        clearTimeout(cue);
        msg.classList.remove("holding");
      }
      state = swipeStep(state, delta);
      if (state.phase === "cancelled") return reset();
      // Under the slop the bubble stays still, so the small drift of a tap never wiggles it.
      if (state.phase !== "swiping") return;
      msg.style.transform = `translateX(${state.dx}px)`;
      msg.style.setProperty("--sw", String(Math.min(1, state.dx / SWIPE_PX)));
      msg.classList.toggle("swipe-ok", state.ok);
    };

    const up = () => {
      if (!msg) return;
      const id = Number(msg.dataset.mi);
      const ok = state.ok;
      reset();
      if (ok) h.current.onReply(id);
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", reset);
    return () => {
      reset();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", reset);
    };
  }, [el]);
}
