import { WifiOff } from "lucide-react";
import type { ConnectionState } from "../../events/use-event-stream";

/** Amber band under the toolbar while the event stream is down or catching up. */
export function ConnectionBanner({ state }: { state: ConnectionState }) {
  if (state === "offline" || state === "reconnecting") {
    return (
      <div className="banner" role="status">
        <WifiOff size={14} strokeWidth={1.75} aria-hidden="true" />
        Can't reach Friday. Reconnecting… Your messages are kept.
      </div>
    );
  }
  if (state === "resyncing") {
    return (
      <div className="banner" role="status">
        Catching up…
      </div>
    );
  }
  return null;
}
