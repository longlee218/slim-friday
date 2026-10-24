import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useReducedMotion, useWidth } from "../../lib/use-media";
import { navHistory } from "./nav-history";
import { PANEL_MIN } from "./panels";

/** View transitions only on desktop and never with Reduce Motion. */
function useTransitions(): boolean {
  const reduced = useReducedMotion();
  const width = useWidth();
  return !reduced && width >= PANEL_MIN.phone;
}

/** Navigate with the macOS view transition; `AppShell` syncs `navHistory` from the URL. */
export function useAppNavigate(): (to: string) => void {
  const navigate = useNavigate();
  const viewTransition = useTransitions();
  return useCallback(
    (to) => {
      void navigate(to, { viewTransition });
    },
    [navigate, viewTransition],
  );
}

/** Back / forward over `navHistory`: moves the cursor and the route (the URL sync is a no-op). */
export function useHistoryNavigate(): { back: () => void; forward: () => void } {
  const navigate = useNavigate();
  const viewTransition = useTransitions();
  const go = (path: string | null) => {
    if (path) void navigate(path, { viewTransition });
  };
  return { back: () => go(navHistory.back()), forward: () => go(navHistory.forward()) };
}
