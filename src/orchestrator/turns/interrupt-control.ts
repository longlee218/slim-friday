import { logEvent, logger } from "../../observability/logger";

/** Logger of this module. */
const log = logger.child({ module: "interrupt-control" });

/** Abort reason that marks a run stopped to be REPLACED: its result and its queue drain are discarded (see route-and-run). */
export const REPLACE_ABORT_REASON = "replaced-by-owner";

/** Whether a run's signal was aborted by a replacement (not by `/stop`, a plain stop or a shutdown). */
export const isReplaced = (signal: AbortSignal): boolean =>
  signal.aborted && signal.reason === REPLACE_ABORT_REASON;

/** One owner order to interrupt the active run of a thread. */
export interface InterruptRequest {
  threadId: string;
  /** The exact controller of the run that is active now. */
  controller: AbortController;
  action: "stop" | "replace";
  /** Ingress id of the owner message (logs only). */
  messageId?: string;
}

/**
 * Deduplicates interrupts: a control message delivered twice, or two orders racing for the same active run, abort that
 * controller ONCE. The first is `accepted` (it marks a replacement via the abort reason); the rest are `duplicate`.
 */
export function createInterruptController() {
  /** Controllers already interrupted (they are never reused for a new run). */
  const interrupted = new WeakSet<AbortController>();
  return {
    requestInterrupt(r: InterruptRequest): "accepted" | "duplicate" {
      if (interrupted.has(r.controller) || r.controller.signal.aborted) {
        logEvent(log, "interrupt.duplicate", { action: r.action, messageId: r.messageId ?? null });
        return "duplicate";
      }
      interrupted.add(r.controller);
      r.controller.abort(r.action === "replace" ? REPLACE_ABORT_REASON : undefined);
      logEvent(log, "interrupt.accepted", { action: r.action, messageId: r.messageId ?? null });
      return "accepted";
    },
  };
}
