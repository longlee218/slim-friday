import type { Database } from "bun:sqlite";
import { isGitLocation, type Location } from "../../locations/location-registry";
import { getLogContext, logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { ROLES } from "../../roles/role-registry";
import { turnRole } from "../../storage/run-store";
import { deliveryEvidence } from "../outputs/delivery-evidence";
import { completesTask, validateOutcome } from "../outputs/outcome-validator";
import type { FlowResult } from "./turn-result";

const log = logger.child({ module: "task-result" });

/**
 * Rule-based result of a finished run (logged `execution.outcome`). `undelivered` = the role must deliver but
 * left no trace: the reply gets one neutral line and the task waits. `parkTask` = a `done` run without delivery
 * evidence (any location kind): the task waits for the owner, no reply note. Bookkeeping only: a failure here
 * never blocks the settle or the reply (both flags false).
 */
export function checkRunOutcome(
  db: Database,
  turnId: string,
  res: FlowResult,
  status: string,
  locations?: Location[],
): { undelivered: boolean; parkTask: boolean } {
  const role = ROLES[turnRole(db, turnId) ?? ""];
  if (!role) return { undelivered: false, parkTask: false };
  try {
    const ev = deliveryEvidence(db, turnId, res.text);
    // Delivery is expected only when the reported location is a git working copy; cwd decides only when none is
    // reported (an unpinned run starts in the first location but may work in another).
    const reported = res.location ? locations?.find((l) => l.name === res.location) : undefined;
    const git = reported ? reported.git : !res.cwd || isGitLocation(res.cwd);
    const outcome = validateOutcome(role, res, ev, getLogContext().traceId ?? "", git);
    const done = res.outcome === "success" && status === "done";
    logEvent(log, "execution.outcome", {
      status: outcome.status,
      artifacts: outcome.artifacts.length,
      actions: outcome.actionsPerformed,
      recoveryHint: outcome.recoveryHint,
      traceId: outcome.traceId,
    });
    return {
      // `partial` after a successful run only happens for a role that must deliver (see `validateOutcome`).
      undelivered: done && outcome.status === "partial",
      // A done run completes its task only with delivery evidence or a role without side effects: a non-git
      // location never reaches `partial` above, but still must not read as completed.
      parkTask: done && !completesTask(role, ev),
    };
  } catch (err) {
    log.warn({ err: errText(err) }, "execution.outcome failed");
    return { undelivered: false, parkTask: false };
  }
}
