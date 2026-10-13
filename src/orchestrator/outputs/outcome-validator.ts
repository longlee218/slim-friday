import type { RunOutcome } from "../../observability/record-run";
import type { RoleDefinition } from "../../roles/role-types";
import type { ExecutionOutcome } from "../../routing/routing-contracts";
import type { DeliveryEvidence } from "./delivery-evidence";

/** One neutral line after a run that was expected to deliver but left no trace of it (never a verdict). */
export const NO_DELIVERY_NOTE =
  "Note: nothing was committed, pushed or opened as a PR in this run.";

/** A role is expected to deliver when it changes a repo: role data, no role name. */
export const expectsDelivery = (role: RoleDefinition): boolean =>
  role.background && role.sideEffects === "repo";

/** Next step to offer per run outcome that did not succeed. */
const HINT: Partial<Record<RunOutcome, string>> = {
  max_budget: "resume",
  error: "resume",
  max_turns: "continue",
  timeout: "rephrase",
  quota: "wait_quota",
};

/**
 * Rule-based result of one run. Pure: `ev` is read by the caller. success = ran to its end (and delivered when the
 * role is expected to); partial = ended with text but no delivery, or stopped on the turn limit; failed = error /
 * timeout; blocked = quota, owner stop.
 */
export function validateOutcome(
  role: RoleDefinition,
  run: { outcome: RunOutcome; text: string },
  ev: DeliveryEvidence,
  traceId: string,
): ExecutionOutcome {
  const base = {
    artifacts: ev.artifacts,
    actionsPerformed: Object.entries(ev.actions).flatMap(([k, n]) => (n > 0 ? [`${k}:${n}`] : [])),
    traceId,
  };
  const hint = HINT[run.outcome];
  const withHint = (status: ExecutionOutcome["status"], recoveryHint = hint): ExecutionOutcome => ({
    status,
    ...base,
    ...(recoveryHint && { recoveryHint }),
  });
  switch (run.outcome) {
    case "success":
      return expectsDelivery(role) && !ev.any
        ? withHint("partial", "continue")
        : withHint("success");
    case "max_turns":
      return withHint(run.text ? "partial" : "failed");
    case "quota":
    case "aborted":
      return withHint("blocked", run.outcome === "aborted" ? "resume" : hint);
    default:
      return withHint("failed");
  }
}
