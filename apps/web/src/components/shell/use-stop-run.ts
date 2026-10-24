import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { client } from "../../api/client";
import { refetchStatus } from "../../events/apply-effects";
import { endRun } from "../../events/apply-runs";
import { liveRunKey } from "../../events/client-keys";

/** What to stop: one bot everywhere, or every bot working in one conversation. */
export type StopTarget = { botId: string } | { conversationId: string };

/**
 * Stops runs with `control.stop`, then toasts and schedules the debounced status refetch
 * (the engine pushes a status event too; this just closes the gap if it is late).
 */
export function useStopRun(): (target: StopTarget) => Promise<void> {
  const qc = useQueryClient();
  return async (target) => {
    try {
      await client.control.stop(target);
      // The stopped session leaves the status list; end its runs now instead of waiting.
      if ("botId" in target) endRun(qc, "*", target.botId);
      else qc.setQueryData(liveRunKey(target.conversationId), {});
      toast("Stopped. Background tasks were cancelled.");
      refetchStatus(qc);
    } catch {
      toast("Could not stop. Try again.");
    }
  };
}
