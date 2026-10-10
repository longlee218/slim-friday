import type { ApprovalGateway } from "../../approvals/approval-types";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { OWNER_CONFIRM_APPROVAL } from "./gates";

/* The owner-confirm gate: a yes/no with buttons before a costlier step (effort `max`, an assistant's
   `ESCALATE: opus`). It FAILS CLOSED: anything but a click on "yes" (no button flow, no answer in time, a
   restart that dropped the pending click, stop/shutdown, a send error) means "do not run the costly step".
   The pending click lives in the gateway's memory, so a click after a restart answers "This action expired."
   with no side effect. The engine knows no role names: the callers say what is being confirmed. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "owner-confirm" });

/** Button labels of the gate: [yes, no]. */
export const OWNER_CONFIRM_LABELS: [string, string] = ["Yes, run it", "No"];

/** What is asked and where. */
export interface OwnerConfirmRequest {
  /** What is being confirmed, for the log (`max_effort` | `escalate_opus`). */
  kind: string;
  /** Id the approval row carries (the task's, or a fresh id before the task exists). */
  taskId: string;
  threadId: string;
  /** The question shown above the buttons. */
  summary: string;
  /** Stop / shutdown: ends the wait with "no". */
  signal?: AbortSignal;
}

/**
 * Ask the owner and wait. True only when the owner clicked "yes". The gateway times the wait out (denied
 * "timeout"); an aborted signal cancels the open request and answers false.
 */
export async function ownerConfirm(
  approvals: ApprovalGateway | undefined,
  req: OwnerConfirmRequest,
): Promise<boolean> {
  const done = (approved: boolean, reason?: string): boolean => {
    logEvent(log, "owner_confirm.decided", { kind: req.kind, approved, reason: reason ?? null });
    return approved;
  };
  if (!approvals) return done(false, "no approval flow");
  if (req.signal?.aborted) return done(false, "aborted");
  const onAbort = () => approvals.cancelTask(req.taskId);
  req.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await approvals.confirm(
      {
        taskId: req.taskId,
        threadId: req.threadId,
        tool: OWNER_CONFIRM_APPROVAL,
        summary: req.summary,
      },
      OWNER_CONFIRM_LABELS,
    );
    return done(r.approved, r.reason);
  } catch (err) {
    log.warn({ err: errText(err) }, "owner confirm failed");
    return done(false, "error");
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
  }
}
