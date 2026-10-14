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
 * Aborts the active run ONCE. `accepted` = this call aborted it (a replace marks it via the abort reason);
 * `duplicate` = the SAME owner message was already handled (concurrent delivery): acknowledge, do nothing more;
 * `stale` = a DIFFERENT message found the controller already interrupted (e.g. `/stop` came first): the caller must
 * still handle that message itself, it is never dropped.
 */
export function createInterruptController() {
  /** Controllers already interrupted (they are never reused for a new run). */
  const interrupted = new WeakSet<AbortController>();
  /** Ingress ids of control messages already handled. */
  const seen = new Set<string>();
  return {
    requestInterrupt(r: InterruptRequest): "accepted" | "duplicate" | "stale" {
      if (r.messageId && seen.has(r.messageId)) {
        logEvent(log, "interrupt.duplicate", { action: r.action, messageId: r.messageId });
        return "duplicate";
      }
      if (r.messageId) seen.add(r.messageId);
      if (interrupted.has(r.controller) || r.controller.signal.aborted) {
        logEvent(log, "interrupt.stale", { action: r.action, messageId: r.messageId ?? null });
        return "stale";
      }
      interrupted.add(r.controller);
      r.controller.abort(r.action === "replace" ? REPLACE_ABORT_REASON : undefined);
      logEvent(log, "interrupt.accepted", { action: r.action, messageId: r.messageId ?? null });
      return "accepted";
    },
  };
}
