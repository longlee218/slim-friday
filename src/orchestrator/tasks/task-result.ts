import type { Database } from "bun:sqlite";
import { excerpt, logEvent, logger } from "../../observability/logger";
import type { RunOutcome, RunUsage } from "../../observability/record-run";
import { redactText } from "../../observability/redact";
import type { RunAgentResult } from "../../runtime/run-agent";
import { finishTask, setTaskStatus, type TaskStatus } from "../../storage/run-store";
import { setSession } from "../../storage/session-store";
import { budgetHitReply } from "../engine/budget";

/* The result of a Q&A or code flow, and the bookkeeping that closes a run. */

/** What the task handler needs back from a Q&A or code flow. */
export interface FlowResult
  extends Pick<
    RunAgentResult,
    "text" | "outcome" | "sessionId" | "resetsAt" | "budgetUsd" | "lastText"
  > {
  /** Metrics of the run (spent USD for the budget-hit message); absent when no run happened. */
  usage?: RunUsage;
  /** cwd + repo of the session to save (resume needs the same cwd), when a session should be stored. */
  cwd?: string;
  repo?: string;
  /** Save the session although the outcome is not success/limit (a stage stopped to await the owner's reply). */
  keepSession?: boolean;
  /** `git diff --stat` of the task clone at a budget stop (the stage runner fills it; budget-hit message). */
  diffStat?: string;
  /** Model of an escalated re-run (the stage row then records it instead of the first run's model). */
  model?: string;
}

/** A run that did not start or failed before any agent result: reply text, no session. */
export const failResult = (text: string, outcome: "error" | "aborted" = "error"): FlowResult => ({
  text,
  outcome,
  sessionId: undefined,
});

/** Map run outcome to the user-facing reply when there is no answer text. */
export const OUTCOME_REPLY: Record<string, string> = {
  max_turns: "Stopped: reached the turn limit.",
  max_budget: "Stopped: reached the budget limit.",
  timeout: "Stopped: timed out.",
  aborted: "Stopped.",
  quota: "Quota exhausted / rate limited. Not retrying automatically.",
  error: "Agent failed. Check the logs.",
};

/** Map run outcome to the task status stored in db. */
const TASK_STATUS: Record<string, TaskStatus> = {
  success: "done",
  aborted: "cancelled",
  timeout: "timeout",
};

/**
 * Outcomes where a result message arrived, so the session transcript exists and can be resumed (the session
 * is saved).
 */
export const RESUMABLE_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  "success",
  "max_turns",
  "max_budget",
]);

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "task-result" });

/** End of a run, same for Q&A and code: save the session, close the task row, return the redacted reply. */
export function finishRun(
  db: Database,
  ids: { taskId: string; threadId: string },
  res: FlowResult,
): string {
  if (res.sessionId && res.cwd && (res.keepSession || RESUMABLE_OUTCOMES.has(res.outcome))) {
    setSession(db, {
      threadId: ids.threadId,
      sessionId: res.sessionId,
      repo: res.repo ?? "*",
      cwd: res.cwd,
    });
    logEvent(log, "session.saved", { repo: res.repo ?? "*", sessionId: res.sessionId });
  }
  finishTask(db, ids.taskId, TASK_STATUS[res.outcome] ?? "failed");
  // Budget hit is never silent: spent / limit, the overshoot note; event `budget.exceeded`.
  if (res.outcome === "max_budget") return budgetHitReply(res);
  // Quota: say when it resets, when the SDK told us.
  const reset =
    res.outcome === "quota" && res.resetsAt
      ? ` Resets at ${new Date(res.resetsAt).toISOString()}.`
      : "";
  return redactText(res.text || `${OUTCOME_REPLY[res.outcome] ?? "No answer."}${reset}`);
}

/**
 * End of a task as the handler sees it: `finishRun`, then `interrupted` instead of cancelled when shutdown
 * aborted it (resumable), then the `task.finished` line. `repo` = repo to log when the flow named none.
 */
export function closeTask(
  db: Database,
  ids: { taskId: string; threadId: string },
  res: FlowResult,
  o: { stopping: boolean; t0: number; repo: string },
): string {
  const reply = finishRun(db, ids, res);
  if (o.stopping && res.outcome === "aborted") setTaskStatus(db, ids.taskId, "interrupted");
  logEvent(log, "task.finished", {
    repo: res.repo && res.repo !== "*" ? res.repo : o.repo,
    outcome: res.outcome,
    durationMs: Date.now() - o.t0,
    reply: excerpt(reply),
  });
  return reply;
}
