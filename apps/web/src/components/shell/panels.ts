/** Smallest window width (px) at which each panel sits beside the chat instead of floating. */
export const PANEL_MIN = { inspector: 1180, sidebar: 900, phone: 640 } as const;

export type PanelName = "sidebar" | "inspector";

export interface PanelState {
  open: boolean;
  /** Opened by hand below its band: overlays the chat and closes on a click outside. */
  floating: boolean;
}

export interface Panels {
  /** Below 640 px the phone layout takes over. */
  mode: "desktop" | "phone";
  sidebar: PanelState;
  inspector: PanelState;
  /** Width these panels were computed for; lets the next call detect a band crossing. */
  width: number;
}

const wide = (width: number, which: PanelName) => width >= PANEL_MIN[which];

/**
 * Panels for a window width. The first call opens a panel iff its band fits. Later calls:
 * crossing a band makes the panel follow it (closes going narrow, opens going wide, floating
 * reset); without a crossing the previous open/floating state is kept (a hand-closed panel
 * stays closed).
 */
export function panelsForWidth(width: number, prev: Panels | null): Panels {
  const next = (which: PanelName): PanelState => {
    if (!prev) return { open: wide(width, which), floating: false };
    if (wide(prev.width, which) === wide(width, which)) return prev[which];
    return { open: wide(width, which), floating: false };
  };
  return {
    mode: width < PANEL_MIN.phone ? "phone" : "desktop",
    sidebar: next("sidebar"),
    inspector: next("inspector"),
    width,
  };
}

/** Toggle one panel; opening it below its band makes it float over the chat. */
export function togglePanel(p: Panels, which: PanelName, width: number): Panels {
  const open = !p[which].open;
  return { ...p, width, [which]: { open, floating: open && !wide(width, which) } };
}
