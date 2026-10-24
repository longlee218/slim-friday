import { useEffect } from "react";
import { navHistory } from "./nav-history";
import { useAppNavigate, useHistoryNavigate } from "./use-app-navigate";
import { usePanels } from "./use-responsive-panels";

export interface ShortcutOptions {
  /** ⌘/Ctrl+K: Task 17 opens the command palette here. */
  onPalette?: () => void;
  /** Esc: close the top overlay (palette, sheet...) before floating panels. Return true if handled. */
  onEscape?: () => boolean | undefined;
}

/** True while the focus is in a text field, where plain shortcuts must not fire. */
function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
    el.closest('[contenteditable=""],[contenteditable="true"]') !== null
  );
}

/**
 * Desktop keyboard shortcuts: ⌘K palette, ⌘0 sidebar, ⌥⌘0 inspector, ⌘1 last chat, ⌘2 tickets,
 * ⌘3 ops, ⌘[ / ⌘] back / forward, Esc closes the top overlay. Ctrl works like ⌘. Used inside
 * `AppShell`; does nothing in phone mode, and only Esc works while typing.
 */
export function useShortcuts({ onPalette, onEscape }: ShortcutOptions = {}): void {
  const panels = usePanels();
  const go = useAppNavigate();
  const history = useHistoryNavigate();
  const { mode, toggle, closeFloating } = panels;

  useEffect(() => {
    if (mode !== "desktop") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!onEscape?.()) closeFloating();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      // e.code is layout-proof: ⌥0 types a different character on a Mac.
      const act: Record<string, () => void> = {
        KeyK: () => onPalette?.(),
        Digit0: () => toggle(e.altKey ? "inspector" : "sidebar"),
        Digit1: () => go(navHistory.lastChat),
        Digit2: () => go("/tickets"),
        Digit3: () => go("/ops"),
        BracketLeft: history.back,
        BracketRight: history.forward,
      };
      const run = act[e.code];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, toggle, closeFloating, onPalette, onEscape, go, history.back, history.forward]);
}
