import { flushSync } from "react-dom";

export type TransitionKind = "push" | "pop" | "theme";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Run a React state change inside a View Transition when the browser supports it.
 * html[data-vt] tells the CSS which animation to use; falls back to a plain update.
 */
export function withViewTransition(kind: TransitionKind, update: () => void): ViewTransition | null {
  if (!document.startViewTransition || reduced()) {
    update();
    return null;
  }
  const root = document.documentElement;
  root.dataset.vt = kind;
  const vt = document.startViewTransition(() => flushSync(update));
  vt.finished.finally(() => {
    if (root.dataset.vt === kind) delete root.dataset.vt;
  });
  return vt;
}

/** Theme change revealed as a circle growing from the clicked point. */
export function revealTheme(x: number, y: number, update: () => void): void {
  const vt = withViewTransition("theme", update);
  if (!vt) return;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 620, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
}
