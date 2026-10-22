import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./ui";

/** Matches the CSS exit transition; the drawer stays mounted this long after a close so it can slide out. */
const EXIT_MS = 220;

/**
 * Side sheet over a dimmed page. Closes on a scrim click, Escape or the close button, sliding out before `onClose`
 * runs (the route change unmounts it). Focus moves into the sheet on open.
 */
export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const [state, setState] = useState<"enter" | "open" | "exit">("enter");
  const sheet = useRef<HTMLElement>(null);

  const close = useCallback(() => {
    setState("exit");
    window.setTimeout(onClose, EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    // Two frames: the first paints the closed position, the second starts the transition from it.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setState("open")));
    sheet.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className={`drawer-layer ${state}`}>
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer" ref={sheet} tabIndex={-1} aria-label="Detail" aria-modal="true" role="dialog">
        <header className="drawer-head">
          {title}
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
