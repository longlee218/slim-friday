import { createContext, useCallback, useContext, useState } from "react";
import { useWidth } from "../../lib/use-media";
import { type PanelName, type Panels, panelsForWidth, togglePanel } from "./panels";

export type ResponsivePanels = Panels & {
  toggle(which: PanelName): void;
  /** Close every panel that was opened by hand over the chat. */
  closeFloating(): void;
};

/** Panel state that follows the window width (see `panelsForWidth`). */
export function useResponsivePanels(): ResponsivePanels {
  const width = useWidth();
  const [state, setState] = useState<Panels>(() => panelsForWidth(width, null));
  // A resize recomputes during render so the first paint at the new width is already right.
  let current = state;
  if (state.width !== width) {
    current = panelsForWidth(width, state);
    setState(current);
  }
  const toggle = useCallback(
    (which: PanelName) => setState((p) => togglePanel(p, which, width)),
    [width],
  );
  const closeFloating = useCallback(
    () =>
      setState((p) => ({
        ...p,
        sidebar: p.sidebar.floating ? { open: false, floating: false } : p.sidebar,
        inspector: p.inspector.floating ? { open: false, floating: false } : p.inspector,
      })),
    [],
  );
  return { ...current, toggle, closeFloating };
}

/** Provided by `AppShell` so the toolbar and shortcuts drive the same panels. */
export const PanelsContext = createContext<ResponsivePanels | null>(null);

/** The panels of the enclosing `AppShell`. */
export function usePanels(): ResponsivePanels {
  const panels = useContext(PanelsContext);
  if (!panels) throw new Error("usePanels must be used inside AppShell");
  return panels;
}
