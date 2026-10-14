import type { Database } from "bun:sqlite";
import { localizeUserCopy, type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { isGitLocation, type Location } from "../../locations/location-registry";
import { excerpt, getLogContext, logEvent, logger } from "../../observability/logger";
import type { RunOutcome, RunUsage } from "../../observability/record-run";
import { errText, redactText } from "../../observability/redact";
import { ROLES } from "../../roles/role-registry";
import type { RunAgentResult } from "../../runtime/run-agent";
import {
  finishTurn,
  setTurnStatus,
  type TurnStatus,
  turnRole,
  turnStatusOf,
} from "../../storage/run-store";
import { setSession } from "../../storage/session-store";
import { settleTaskAfterTurn } from "../../tasks/task-resolver";
import { budgetHitReply } from "../engine/budget";
import { deliveryEvidence } from "../outputs/delivery-evidence";
import { NO_DELIVERY_NOTE, validateOutcome } from "../outputs/outcome-validator";
import { requestRollover } from "./thread-rollover";

/* The result of a role run, and the bookkeeping that closes a run. */

/** What the task handler needs back from a role run. */
export interface FlowResult
  extends Pick<
    RunAgentResult,
    | "text"
    | "outcome"
    | "sessionId"
    | "resetsAt"
    | "budgetUsd"
    | "ceilingBound"
    | "lastText"
    | "spentBeforeUsd"
  > {
  /** The text is a verified refusal of the app (not an SDK exception), so the owner may read it. */
  refusal?: true;
  /** Metrics of the run (spent USD for the budget-hit message); absent when no run happened. */
  usage?: RunUsage;
  /** cwd + location of the session to save (resume needs the same cwd), when a session should be stored. */
  cwd?: string;
  location?: string;
  /** Save the session although the outcome is not success/limit (a run stopped to await the owner's reply). */
  keepSession?: boolean;
  /** Do not save this run's session as the thread's (a background run in the location itself: a later assistant message in the thread must not resume it). */
  skipThreadSession?: true;
  /** Model of an escalated re-run (the first run's model is then not the one that answered). */
  model?: string;
  /** Set by the role runner: the failure qualifies for `failed_resumable` (its session is kept). */
  resumable?: ResumeReason;
}

/** A run that did not start or failed before any agent result: reply text, no session. */
export const failResult = (text: string, outcome: "error" | "aborted" = "error"): FlowResult => ({
  text,
  outcome,
  sessionId: undefined,
  // The text is a verified refusal of the app (not an SDK exception): the owner may read it.
  refusal: outcome === "error" ? true : undefined,
});

/** Map run outcome to the user-facing reply when there is no answer text. */
export const OUTCOME_REPLY: Record<string, string> = Object.fromEntries(
  ["max_turns", "max_budget", "timeout", "aborted", "quota", "error"].map((outcome) => [
    outcome,
    renderUserNotice({ kind: "outcome", outcome }, "en"),
  ]),
);

/** Why a background run stopped but can be continued: label shown to the owner (the key is the reason). */
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

/** The reason a failed run can be resumed, or undefined (stop, restart, timeout and quota do not qualify). */
export const resumeReasonOf = (r: FlowResult): ResumeReason | undefined =>
  RESUMABLE_WHEN.find(([, when]) => when(r))?.[0];

/** The question L3 reads the owner's next message against (same words as the notice of the failure). */
export const resumeQuestion = (): string =>
  renderUserNotice({ kind: "decision", state: "resume" }, "en");

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
/** End of a run, same for every role: save the session, close the turn row, return the redacted reply. */
export function finishRun(
  db: Database,
  ids: { turnId: string; threadId: string },
  res: FlowResult,
  language: OwnerLanguage,
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
      location: res.location ?? "*",
      cwd: res.cwd,
    });
    logEvent(log, "session.saved", { location: res.location ?? "*", sessionId: res.sessionId });
    // Context over the share of the model window: the handler rolls the thread after the reply is posted.
    if (res.outcome === "success") requestRollover(db, ids, res.usage);
  }
  finishTurn(
    db,
    ids.turnId,
    res.resumable ? "failed_resumable" : (TURN_STATUS[res.outcome] ?? "failed"),
  );
  if (res.outcome === "max_budget") return budgetHitReply(res, language);
  // Unknown failure text may be an SDK exception. Keep it in the audit/log path, never guess a cause from it.
  const unknownError = res.outcome === "error" && !res.refusal;
  if (unknownError) logEvent(log, "run.failed", { reason: "error", detail: redactText(res.text) });
  const text = unknownError
    ? renderUserNotice({ kind: "failure" }, language)
    : redactText(
        localizeUserCopy(
          res.text ||
            renderUserNotice(
              { kind: "outcome", outcome: res.outcome, resetsAt: res.resetsAt },
              language,
            ),
          language,
        ),
      );
  return res.resumable
    ? `${text}\n${renderUserNotice({ kind: "decision", state: "resume" }, language)}`
    : text;
}

/**
 * End of a task as the handler sees it: `finishRun`, then `interrupted` instead of cancelled when shutdown
 * aborted it (resumable), then the `task.finished` line. `location` = location to log when the flow named none.
 */
export function closeTurn(
  db: Database,
  ids: { turnId: string; threadId: string },
  res: FlowResult,
  o: {
    stopping: boolean;
    t0: number;
    location: string;
    locations?: Location[];
    language: OwnerLanguage;
  },
): string {
  let reply = finishRun(db, ids, res, o.language);
  if (o.stopping && res.outcome === "aborted") setTurnStatus(db, ids.turnId, "interrupted");
  const status = turnStatusOf(db, ids.turnId);
  // Rule-based result of the run (logged `execution.outcome`); a role that must deliver but left no trace of it
  // gets the reply it wrote plus one neutral line, and its task waits for the owner (no re-run, no marker).
  const role = ROLES[turnRole(db, ids.turnId) ?? ""];
  let undelivered = false;
  // Bookkeeping only: a failure here must never block the task settle, `task.finished` or the reply.
  try {
    if (role) {
      const ev = deliveryEvidence(db, ids.turnId, res.text);
      // Delivery is expected only when the reported location is a git working copy; cwd decides only when none is
      // reported (an unpinned run starts in the first location but may work in another).
      const reported = res.location ? o.locations?.find((l) => l.name === res.location) : undefined;
      const git = reported ? reported.git : !res.cwd || isGitLocation(res.cwd);
      const outcome = validateOutcome(role, res, ev, getLogContext().traceId ?? "", git);
      // `partial` after a successful run only happens for a role that must deliver (see `validateOutcome`).
      undelivered = res.outcome === "success" && status === "done" && outcome.status === "partial";
      if (undelivered)
        reply = `${reply}\n\n${renderUserNotice({ kind: "note", state: "no-delivery" }, o.language)}`;
      logEvent(log, "execution.outcome", {
        status: outcome.status,
        artifacts: outcome.artifacts.length,
        actions: outcome.actionsPerformed,
        recoveryHint: outcome.recoveryHint,
        traceId: outcome.traceId,
      });
    }
  } catch (err) {
    undelivered = false;
    log.warn({ err: errText(err) }, "execution.outcome failed");
  }
  // The owned task follows the turn's final status (no-op for a turn that owns none).
  settleTaskAfterTurn(db, ids.turnId, status, undelivered);
  logEvent(log, "task.finished", {
    location: res.location && res.location !== "*" ? res.location : o.location,
    outcome: res.outcome,
    durationMs: Date.now() - o.t0,
    reply: excerpt(reply),
  });
  return reply;
}
