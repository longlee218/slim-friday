import { type RefObject, useEffect } from "react";

/**
 * While `on`, mirrors the visual viewport onto `ref` as `--vv-h` (the visible height) and
 * `--kb-h` (what covers the bottom of the layout viewport: the iOS keyboard), so a fixed bottom
 * sheet can rest on the keyboard and fit above it. `100dvh` alone ignores the keyboard.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    const sync = () => {
      const el = ref.current;
      if (!el) return;
      el.style.setProperty("--vv-h", `${vv.height}px`);
      el.style.setProperty(
        "--kb-h",
        `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`,
      );
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [ref, on]);
}
