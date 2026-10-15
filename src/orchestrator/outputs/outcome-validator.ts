import { renderUserNotice } from "../../ingress/user-copy";
import type { RunOutcome } from "../../observability/record-run";
import type { RoleDefinition } from "../../roles/role-types";
import type { ExecutionOutcome } from "../../routing/routing-contracts";
import type { DeliveryEvidence } from "./delivery-evidence";

/** One neutral line after a run that was expected to deliver but left no trace of it (never a verdict). */
export const NO_DELIVERY_NOTE = renderUserNotice({ kind: "note", state: "no-delivery" }, "en");

/**
 * A role is expected to deliver when it changes a git location (role data, no role name). A location
 * without a git dir has no git delivery to expect (`git` false).
 */
export const expectsDelivery = (role: RoleDefinition, git = true): boolean =>
  git && role.background && role.sideEffects === "location";

/**
 * A run that ended `done` completes its task only with delivery evidence, or when the role has no side effects
 * to deliver (`sideEffects: "none"`). Anything else (no evidence, e.g. the work happened in a non-git location
 * or the agent only asked the owner in prose) leaves the task waiting for the owner.
 */
export const completesTask = (role: RoleDefinition, ev: DeliveryEvidence): boolean =>
  ev.any || role.sideEffects === "none";

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
  git = true,
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
      return expectsDelivery(role, git) && !ev.any
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
