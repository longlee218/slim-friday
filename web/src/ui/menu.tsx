import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icon";
import { EXIT_FAST, SPRING_SNAPPY } from "./motion-presets";

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect(): void;
  /** Destructive action: drawn in red, kept last. */
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, shown under its label. */
  hint?: string;
}

/** Screen point the menu opens from (a click, a long press, or a button's corner). */
export interface MenuAnchor {
  x: number;
  y: number;
}

interface Props {
  anchor: MenuAnchor | null;
  label: string;
  items: MenuItem[];
  onClose(): void;
}

const WIDTH = 228;
const ROW = 36;
const GUTTER = 12;

/**
 * Context menu at a point, kept inside the viewport.
 * Arrow keys move between items, Esc or a click outside closes it.
 */
export function Menu({ anchor, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    // Defer so the pointer that opened the menu does not close it.
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  // Flip above the point or shift left when the menu would leave the screen.
  const height = items.reduce((h, it) => h + (it.hint ? ROW + 14 : ROW), 10);
  const left = anchor ? Math.max(GUTTER, Math.min(anchor.x, innerWidth - WIDTH - GUTTER)) : 0;
  const below = anchor ? anchor.y + height + GUTTER < innerHeight : true;
  const top = anchor ? (below ? anchor.y : Math.max(GUTTER, anchor.y - height)) : 0;

  return createPortal(
    <AnimatePresence>
      {anchor && (
        <motion.div
          ref={ref}
          role="menu"
          aria-label={label}
          className="menu"
          style={{ left, top, width: WIDTH, transformOrigin: below ? "top left" : "bottom left" }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1, transition: SPRING_SNAPPY }}
          exit={{ opacity: 0, scale: 0.96, transition: EXIT_FAST }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="menu__item"
              data-danger={it.danger || undefined}
              disabled={it.disabled}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              <span className="menu__text">
                {it.label}
                {it.hint && <small>{it.hint}</small>}
              </span>
              <Icon name={it.icon} />
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
