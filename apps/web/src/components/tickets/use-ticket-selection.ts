import { useCallback, useContext } from "react";
import { useLocation, useSearchParams } from "react-router";
import { PanelsContext } from "../shell/use-responsive-panels";

/** Query parameter holding the ref of the ticket whose drawer is open (`/tickets?t=FRI-3`). */
const PARAM = "t";

/** The ref of the open drawer; only the board route (`/tickets`) has one. */
export function useSelectedTicket(): string | null {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  return pathname === "/tickets" ? params.get(PARAM) : null;
}

/**
 * Opens the drawer on a ticket (or closes it with `null`) by editing the URL, so a reload and
 * Back keep it. Opening also opens the inspector column if the window hides it (outside the
 * desktop shell there are no panels and nothing else to do).
 */
export function useSelectTicket(): (ref: string | null) => void {
  const [, setParams] = useSearchParams();
  const panels = useContext(PanelsContext);
  const inspectorOpen = panels?.inspector.open ?? true;
  const toggle = panels?.toggle;
  return useCallback(
    (ref) => {
      setParams(ref ? { [PARAM]: ref } : {}, { replace: true });
      if (ref && !inspectorOpen) toggle?.("inspector");
    },
    [setParams, inspectorOpen, toggle],
  );
}
