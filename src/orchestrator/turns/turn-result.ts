import type { Database } from "bun:sqlite";
import { localizeUserCopy, type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { excerpt, logEvent, logger } from "../../observability/logger";
import { redactText } from "../../observability/redact";
import type { RunOutcome, RunUsage } from "../../observability/run-usage";
import type { RunAgentResult } from "../../runtime/run-agent";
import type { ResultKind } from "../../storage/owned-item-store";
import { finishTurn, setTurnStatus, type TurnStatus, turnStatusOf } from "../../storage/run-store";
import { setSession } from "../../storage/session-store";
import { budgetHitReply } from "../budget/budget-hit";
import type { DeliveryExpectation } from "./completion";
import { type ArtifactScope, saveResultFile } from "./result-file-save";
import { settleTurn } from "./turn-settle";

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
    | "transient"
  > {
  /** The text is a verified refusal of the app (not an SDK exception), so the owner may read it. */
  refusal?: true;
  /** Metrics of the run (spent USD for the budget-hit message); absent when no run happened. */
  usage?: RunUsage;
  /** cwd + location of the session to save (resume needs the same cwd). */
  cwd?: string;
  location?: string;
  /** Save the session although the outcome is not success/limit (a run stopped to await the owner). */
  keepSession?: boolean;
  /** Do not save this session as the thread's (a worker run: a later lead message must not resume it). */
  skipThreadSession?: true;
  /** The session is the lead's (stored with `kind='lead'` and the model): set by the lead runner only. */
  sessionKind?: "lead";
  /** Model that answered (stored with the session). */
  model?: string;
}

/** A run that did not start or failed before any agent result: reply text, no session. `refusal: true` marks a verified app refusal (not an SDK exception): the owner may read it. */
export const failResult = (text: string, outcome: "error" | "aborted" = "error"): FlowResult => ({
  text,
  outcome,
  sessionId: undefined,
  refusal: outcome === "error" ? true : undefined,
});

/** Run outcome to the turn status stored in db (any other outcome = failed). */
const TURN_STATUS: Record<string, TurnStatus> = {
  success: "done",
  aborted: "cancelled",
  timeout: "timeout",
};

/** Outcomes where a result message arrived: the transcript exists, so the session is saved. */
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
      ...(res.sessionKind && { kind: res.sessionKind, model: res.model }),
    });
    logEvent(log, "session.saved", { location: res.location ?? "*", sessionId: res.sessionId });
  }
  finishTurn(db, ids.turnId, TURN_STATUS[res.outcome] ?? "failed");
  if (res.outcome === "max_budget") return budgetHitReply(res, language);
  // A lead run may answer with tool calls only: say nothing then.
  if (res.sessionKind === "lead" && res.outcome === "success" && !res.text.trim()) return "";
  // Unknown failure text may be an SDK exception: log it, never show it.
  const unknownError = res.outcome === "error" && !res.refusal;
  if (unknownError) logEvent(log, "run.failed", { reason: "error", detail: redactText(res.text) });
  return unknownError
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
}

/**
 * End of a task: `finishRun`, `interrupted` instead of cancelled when shutdown aborted it (resumable), settle the
 * owned task, save the result file, log `task.finished`. `location` is logged when the flow named none.
 */
export function closeTurn(
  db: Database,
  ids: { turnId: string; threadId: string },
  res: FlowResult,
  o: {
    stopping: boolean;
    t0: number;
    location: string;
    language: OwnerLanguage;
    /** AGENT_HOME: artifact store root for the task's result (absent = no result recorded). */
    agentHome?: string;
    /** Workspace and channel of the result artifact (absent = no store write, only the excerpt). */
    artifactScope?: ArtifactScope;
    /** Typed result the worker reported: it settles the task when the turn ended `done`. */
    resultKind?: ResultKind;
    /** Title the worker gave its result (heading and artifact name). */
    resultTitle?: string;
    /** Delivery effects the plan promised: a COMPLETED last item without their `effect_log` rows is not delivered. */
    delivery?: DeliveryExpectation;
    /** Worker failure policy: true = it moved the item itself (resume or hold), skip the normal settle. */
    failurePolicy?: (res: FlowResult, status: string) => boolean;
  },
): string {
  let reply = finishRun(db, ids, res, o.language);
  if (o.stopping && res.outcome === "aborted") setTurnStatus(db, ids.turnId, "interrupted");
  const status = turnStatusOf(db, ids.turnId);
  const settled = settleTurn(db, ids.turnId, res, status, o);
  reply += settled.note;
  saveResultFile(db, ids.turnId, status, res.outcome, reply, o.resultKind, o.resultTitle);
  logEvent(log, "task.finished", {
    location: res.location && res.location !== "*" ? res.location : o.location,
    outcome: res.outcome,
    durationMs: Date.now() - o.t0,
    reply: excerpt(reply),
  });
  return reply;
}
