import type { Route } from "../../config/model-routing";
import { logEvent, logger } from "../../observability/logger";
import type { RunAgentResult } from "../../runtime/run-agent";
import { remainingUsd } from "../budget/task-budget";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "answer-output" });

/**
 * One agent run plus the run supervisor's single recovery. A NON-success first run may be resumed ONCE with a trusted
 * internal hint (`recover` decides; it gets what the task ceiling still leaves).
 */
export async function answerOutput(a: {
  run: (route: Route | undefined, sessionId?: string) => Promise<RunAgentResult>;
  resume?: string;
  /** Route of the run (spent so far counts against the ceiling). */
  route?: Route;
  recover?: (
    res: RunAgentResult,
    ctx: { alreadyReran: boolean; remainingBudgetUsd: number },
  ) => string | undefined;
}): Promise<RunAgentResult> {
  const first = await a.run(undefined, a.resume);
  if (first.outcome === "success" || !a.recover) return first;
  const spentUsd = (a.route?.spentUsd ?? 0) + first.usage.costUsd;
  const hint = a.recover(first, {
    alreadyReran: false,
    remainingBudgetUsd: remainingUsd(spentUsd),
  });
  if (!hint) return first;
  logEvent(log, "supervisor.rerun", { reason: first.outcome });
  return a.run({ spentUsd, internalHint: hint }, first.sessionId);
}
