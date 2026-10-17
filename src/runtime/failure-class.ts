import type { RunOutcome } from "../observability/record-run";
import { RESUME_FAILED } from "./run-errors";

/* Failure classes of a worker run (pure): is the failure worth an automatic resume of the same session (`transient`),
   a failure the lead must decide on (`real`), or the owner's own stop (`owner_stop`, a cancel, never resumed)? */

/** Provider / network phrases that pass by themselves: overload, 5xx, rate limit without a usage window, dropped connection. */
const TRANSIENT_TEXT =
  /overloaded|api error:?\s*(429|5\d\d)|status(?: code)?:?\s*(429|5\d\d)|(?<![:.\w])(502|503|504|529)(?![:.\w])|internal server error|bad gateway|service unavailable|gateway timeout|rate[ _]limit|too many requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network (error|socket)/i;

/** True when raw error text (SDK result error, thrown message) names a transient provider or network failure. */
export const isTransientError = (errorText: string | undefined): boolean =>
  !!errorText && TRANSIENT_TEXT.test(errorText);

/** `transient`: resume the same session; `real`: hold the item for the lead; `owner_stop`: the owner cancelled it. */
export type FailureClass = "transient" | "real" | "owner_stop";

/** What the run ended with. */
export interface FailureInput {
  outcome: RunOutcome;
  /** Raw error text, when the run kept it (a failed resume keeps it; other errors are blanked after the stream marks `transient`). */
  errorText?: string;
  /** The stream already saw a transient error before it blanked the text. */
  transient?: boolean;
  /** Why the app aborted the run (watchdog: `stale`, age limit: `item_age`); absent = nobody but the owner or the shutdown. */
  abortCause?: "stale" | "item_age";
  /** The process is shutting down (SIGTERM): the abort is a restart, not a decision. */
  stopping?: boolean;
}

/** Class and short machine cause (logged, put in the `failure` event) of a run that did not deliver a result. */
export function classifyRunFailure(i: FailureInput): { class: FailureClass; cause: string } {
  if (i.outcome === "aborted") {
    if (i.stopping) return { class: "transient", cause: "shutdown" };
    if (i.abortCause === "stale") return { class: "transient", cause: "stale" };
    // The item outlived its age limit: a decision for the lead, never an automatic resume.
    if (i.abortCause === "item_age") return { class: "real", cause: "item_age" };
    return { class: "owner_stop", cause: "owner_stop" };
  }
  // A failed resume is retried once more as a fresh start (the resume prompt falls back to the brief).
  if (i.errorText && RESUME_FAILED.test(i.errorText))
    return { class: "transient", cause: "resume_failed" };
  if (
    (i.outcome === "error" || i.outcome === "quota") &&
    (i.transient || isTransientError(i.errorText))
  )
    return { class: "transient", cause: "api_error" };
  // max_budget, max_turns, timeout, quota with a usage window, unknown errors: the lead decides.
  return { class: "real", cause: i.outcome };
}
