import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSyncExternalStore } from "react";
import { IconButton } from "../ui/button";
import { navHistory } from "./nav-history";
import { useHistoryNavigate } from "./use-app-navigate";

/** Back / Forward chevrons over the window-style history; disabled at either end. */
export function NavButtons() {
  // Re-render whenever the history cursor moves.
  useSyncExternalStore(navHistory.subscribe, () => navHistory.version);
  const { back, forward } = useHistoryNavigate();
  return (
    <span className="navbtns">
      <IconButton label="Back (⌘[)" disabled={!navHistory.canBack} onClick={back}>
        <ChevronLeft size={16} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Forward (⌘])" disabled={!navHistory.canForward} onClick={forward}>
        <ChevronRight size={16} strokeWidth={1.75} />
      </IconButton>
    </span>
  );
}
