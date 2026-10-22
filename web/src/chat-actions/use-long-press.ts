import { type MouseEvent, type PointerEvent, useRef } from "react";

const HOLD_MS = 450;
/** Finger travel (px) that turns a press into a scroll. */
const SLOP = 8;

/**
 * Long press on touch, right click on desktop: both call `onPress` with the
 * screen point. The click that ends a long press is swallowed so the row
 * does not open as well.
 */
export function useLongPress(onPress: (x: number, y: number) => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };

  return {
    onPointerDown(e: PointerEvent) {
      fired.current = false;
      if (e.pointerType !== "touch") return;
      const { clientX: x, clientY: y } = e;
      start.current = { x, y };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(8);
        onPress(x, y);
      }, HOLD_MS);
    },
    onPointerMove(e: PointerEvent) {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(e: MouseEvent) {
      e.preventDefault();
      // Android fires contextmenu on its own long press; the timer already opened the menu.
      if (!fired.current) onPress(e.clientX, e.clientY);
    },
    onClickCapture(e: MouseEvent) {
      if (!fired.current) return;
      e.preventDefault();
      e.stopPropagation();
      fired.current = false;
    },
  };
}
