import type { Database } from "bun:sqlite";
import { excerpt, logEvent, logger } from "../../observability/logger";
import type { RunOutcome, RunUsage } from "../../observability/record-run";
import { redactText } from "../../observability/redact";
import type { RunAgentResult } from "../../runtime/run-agent";
import { finishTurn, setTurnStatus, type TurnStatus } from "../../storage/run-store";
import { setSession } from "../../storage/session-store";
import { budgetHitReply } from "../engine/budget";
import { compactIdleSession } from "./session-compaction";

/* The result of a Q&A or code flow, and the bookkeeping that closes a run. */

/** What the task handler needs back from a Q&A or code flow. */
export interface FlowResult
  extends Pick<
    RunAgentResult,
    "text" | "outcome" | "sessionId" | "resetsAt" | "budgetUsd" | "ceilingBound" | "lastText"
  > {
  /** Metrics of the run (spent USD for the budget-hit message); absent when no run happened. */
  usage?: RunUsage;
  /** cwd + repo of the session to save (resume needs the same cwd), when a session should be stored. */
  cwd?: string;
  repo?: string;
  /** Save the session although the outcome is not success/limit (a stage stopped to await the owner's reply). */
  keepSession?: boolean;
  /** Do not save this run's session as the thread's (an exec run in the repo itself: a later assistant message in the thread must not resume it). */
  skipThreadSession?: true;
  /** Model of an escalated re-run (the stage row then records it instead of the first run's model). */
  model?: string;
  /** Set by the stage runner: the failure qualifies for `failed_resumable` (the plan is kept; so are a legacy clone and session). */
  resumable?: ResumeReason;
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

/** Why a run after the approved plan stopped but can be continued: label shown to the owner (the key is the stage verdict). */
export const RESUMABLE = {
  budget: "budget limit reached",
  error: "agent error",
} as const;
export type ResumeReason = keyof typeof RESUMABLE;

/** Which failures qualify for `failed_resumable`, first match wins: one row per reason. Anything else stays `failed`. */
const RESUMABLE_WHEN: ReadonlyArray<readonly [ResumeReason, (r: FlowResult) => boolean]> = [
  ["budget", (r) => r.outcome === "max_budget"],
  ["error", (r) => r.outcome === "error"],
];

/** The reason a failed run can be resumed, or undefined (stop, restart, timeout, quota and a failure before the plan do not qualify). */
export const resumeReasonOf = (r: FlowResult): ResumeReason | undefined =>
  RESUMABLE_WHEN.find(([, when]) => when(r))?.[0];

/** The question L3 reads the owner's next message against (same words as the notice of the failure). */
export const resumeQuestion = (turnId: string, reason: string): string =>
  `Task ${turnId.slice(0, 8)} stopped at exec: ${reason}. Continue with the approved plan?`;

/** Map run outcome to the task status stored in db. */
const TURN_STATUS: Record<string, TurnStatus> = {
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

/** End of a run, same for Q&A and code: save the session, close the turn row, return the redacted reply. */
export function finishRun(
  db: Database,
  ids: { turnId: string; threadId: string },
  res: FlowResult,
): string {
  if (
    !res.skipThreadSession &&
    res.sessionId &&
    res.cwd &&
    (res.keepSession || RESUMABLE_OUTCOMES.has(res.outcome))
  ) {
    setSession(db, {
      threadId: ids.threadId,
      sessionId: res.sessionId,
      repo: res.repo ?? "*",
      cwd: res.cwd,
    });
    logEvent(log, "session.saved", { repo: res.repo ?? "*", sessionId: res.sessionId });
    // A finished task over the size threshold: forget the session, the next turn starts fresh with the ledger.
    if (res.outcome === "success") compactIdleSession(db, ids, res.usage);
  }
  finishTurn(
    db,
    ids.turnId,
    res.resumable ? "failed_resumable" : (TURN_STATUS[res.outcome] ?? "failed"),
  );
  // Budget hit is never silent: spent / limit, the overshoot note; event `budget.exceeded`.
  if (res.outcome === "max_budget") return budgetHitReply(res);
  // Quota: say when it resets, when the SDK told us.
  const reset =
    res.outcome === "quota" && res.resetsAt
      ? ` Resets at ${new Date(res.resetsAt).toISOString()}.`
      : "";
  const text = redactText(res.text || `${OUTCOME_REPLY[res.outcome] ?? "No answer."}${reset}`);
  // A resumable failure ends with the question (reply yes or `/go`): the plan is kept (and a legacy clone and session).
  return res.resumable
    ? `${text}\n${resumeQuestion(ids.turnId, RESUMABLE[res.resumable])} Reply yes or send \`/go\`.`
    : text;
}

/**
 * End of a task as the handler sees it: `finishRun`, then `interrupted` instead of cancelled when shutdown
 * aborted it (resumable), then the `task.finished` line. `repo` = repo to log when the flow named none.
 */
export function closeTurn(
  db: Database,
  ids: { turnId: string; threadId: string },
  res: FlowResult,
  o: { stopping: boolean; t0: number; repo: string },
): string {
  const reply = finishRun(db, ids, res);
  if (o.stopping && res.outcome === "aborted") setTurnStatus(db, ids.turnId, "interrupted");
  logEvent(log, "task.finished", {
    repo: res.repo && res.repo !== "*" ? res.repo : o.repo,
    outcome: res.outcome,
    durationMs: Date.now() - o.t0,
    reply: excerpt(reply),
  });
  return reply;
}
