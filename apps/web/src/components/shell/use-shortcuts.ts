import { useEffect, useRef } from "react";
import { navHistory } from "./nav-history";
import { useAppNavigate, useHistoryNavigate } from "./use-app-navigate";
import { usePanels } from "./use-responsive-panels";

export interface ShortcutOptions {
  /** ⌘/Ctrl+K: Task 17 opens the command palette here. Works while typing. */
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
 * `AppShell`; does nothing in phone mode. While typing only ⌘K and Esc work; modifiers are
 * matched exactly (Alt only for ⌥⌘0, Shift never).
 */
export function useShortcuts(options: ShortcutOptions = {}): void {
  const { mode, toggle, closeFloating } = usePanels();
  const go = useAppNavigate();
  const history = useHistoryNavigate();
  // Latest values live in a ref so the window listener binds once per mode.
  const latest = useRef({ options, toggle, closeFloating, go, history });
  latest.current = { options, toggle, closeFloating, go, history };

  useEffect(() => {
    if (mode !== "desktop") return;
    const onKey = (e: KeyboardEvent) => {
      const { options, toggle, closeFloating, go, history } = latest.current;
      if (e.key === "Escape") {
        if (!options.onEscape?.()) closeFloating();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const typing = isTyping(e.target);
      // e.code is layout-proof: ⌥0 types a different character on a Mac.
      const plain: Record<string, () => void> = {
        Digit0: () => toggle("sidebar"),
        Digit1: () => go(navHistory.lastChat),
        Digit2: () => go("/tickets"),
        Digit3: () => go("/ops"),
        BracketLeft: history.back,
        BracketRight: history.forward,
      };
      let run: (() => void) | undefined;
      if (e.code === "KeyK" && !e.altKey) run = () => options.onPalette?.();
      else if (e.code === "Digit0" && e.altKey && !typing) run = () => toggle("inspector");
      else if (!e.altKey && !typing) run = plain[e.code];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);
}
