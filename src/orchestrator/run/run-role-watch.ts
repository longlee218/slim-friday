import { logEvent, logger } from "../../observability/logger";
import { mayHaveWritten } from "../../roles/capability-registry";
import type { RoleDefinition } from "../../roles/role-types";
import type { RunAgentResult } from "../../runtime/run-agent";
import { createRunSupervisor, recoverOnce } from "../../runtime/run-supervisor";
import type { RoleRunInput, RoleRunnerDeps } from "./role-run-types";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-role" });

/**
 * The run supervisor of ONE owner message and what feeds it: it counts turns, trusted tool issues and guard denials,
 * follows the owner steers of THIS run (SDK-confirmed states only) and an owner stop. It only decides; the retry
 * itself is answerOutput's. `awaiting` reads the ask-timeout text (set while the owner is being waited on).
 */
export function watchRun(
  deps: RoleRunnerDeps,
  i: RoleRunInput,
  role: RoleDefinition,
  awaiting: () => string | undefined,
) {
  const supervisor = createRunSupervisor({
    maxTurns: role.limits.maxTurns,
    alreadyRecovered: false,
  });
  /** Audit line of a supervisor action: the technical reason, state words and numbers only (no owner text, no hint). */
  const audit = (action: string, reason: string) => {
    const s = supervisor.snapshot();
    logEvent(log, "run.control", {
      action,
      reason,
      turnId: i.turnId,
      turns: s.turns,
      issues: Object.values(s.issues).reduce((a, b) => a + (b ?? 0), 0),
      guardDenied: s.guardDenied,
      ...(s.steer && { steer: s.steer }),
    });
  };
  /** The last result the supervisor saw (a retry produces a second one). */
  let observed: unknown;
  const observeResult = (result: { outcome: string; sessionId?: string }) => {
    observed = result;
    return supervisor.observe({
      kind: "run_result",
      outcome: result.outcome,
      resumable: !!result.sessionId,
    });
  };
  const unwatchSteer = deps.steer?.subscribe(i.threadId, i.turnId, (e) =>
    supervisor.observe({ kind: "owner_steer_state", state: e.state }),
  );
  i.ac.signal.addEventListener("abort", () => supervisor.observe({ kind: "owner_stop" }), {
    once: true,
  });
  return {
    supervisor,
    unwatchSteer,
    /** Post-result boundary: a role that may have partly written (files, or an external side effect) is never re-run automatically. */
    recover: (result: RunAgentResult, c: { alreadyReran: boolean; remainingBudgetUsd: number }) => {
      const decision = observeResult(result);
      const d = recoverOnce({
        result,
        snapshot: supervisor.snapshot(),
        alreadyReran: c.alreadyReran,
        remainingBudgetUsd: c.remainingBudgetUsd,
        uncertainPartialWrite: mayHaveWritten(role),
        approvalWaiting: !!awaiting(),
      });
      if (d.kind === "resume") {
        audit("recover", decision.kind === "recover_after_result" ? decision.reason : "turn_limit");
        return d.hint;
      }
      if (decision.kind === "recover_after_result") {
        // The supervisor wanted a recovery but a guard of the selector said no: say which one.
        audit(
          "recover_suppressed",
          mayHaveWritten(role)
            ? "uncertain_partial_write"
            : awaiting()
              ? "approval_waiting"
              : !result.sessionId
                ? "no_session"
                : "no_budget",
        );
      } else if (decision.kind === "report_incomplete") audit("report_incomplete", decision.reason);
      return undefined;
    },
    /** A retry produced a second result: the supervisor sees it too (a failed retry is reported as exhausted). */
    afterRetry: (res: RunAgentResult) => {
      if (res.outcome !== "success" && observed !== undefined && observed !== res) {
        const d = observeResult(res);
        if (d.kind === "report_incomplete") audit("report_incomplete", d.reason);
      }
    },
  };
}
