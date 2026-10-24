import { WifiOff } from "lucide-react";
import type { ConnectionState } from "../../events/use-event-stream";

/** Amber band under the toolbar while the event stream is down or catching up. */
export function ConnectionBanner({ state }: { state: ConnectionState }) {
  const text =
    state === "offline" || state === "reconnecting"
      ? "Can't reach Friday. Reconnecting… Your messages are kept."
      : state === "resyncing"
        ? "Catching up…"
        : null;
  // The live region stays mounted so screen readers announce the change.
  return (
    <div role="status" aria-live="polite">
      {text && (
        <div className="banner">
          {state !== "resyncing" && <WifiOff size={14} strokeWidth={1.75} aria-hidden="true" />}
          {text}
        </div>
      )}
    </div>
  );
}
