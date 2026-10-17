import type { Database } from "bun:sqlite";
import { AUTO_RESUME_CAP, RESUME_BACKOFF_STEP_MS } from "../../config/resilience-caps";
import { logEvent, logger } from "../../observability/logger";
import { classifyRunFailure, type FailureClass } from "../../runtime/failure-class";
import {
  bumpAttempt,
  getItem,
  type ResultKind,
  setResultKind,
} from "../../storage/owned-item-store";
import { setTurnSession } from "../../storage/run-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { runOfTask } from "../run/live-runs";
import type { FlowResult } from "../turns/turn-result";
import { holdUntil } from "./resume-backoff";

/* What happens to a goal item whose run did not deliver: a transient failure resumes the same session (capped, with
   backoff), anything else holds the item `blocked` (result FAILED) with its dependents waiting, and the lead decides
   (retry or cancel). The owner's own stop is a cancel and is not handled here. */

/** Logger of this module. */
const log = logger.child({ module: "failure-policy" });

/** What the policy did, for the end event of the run. */
export interface FailureVerdict {
  action: "resume" | "hold";
  class: FailureClass;
  cause: string;
  /** Automatic resumes used so far (after this one). */
  attempt: number;
}

/** What the run ended with. */
interface PolicyInput {
  db: Database;
  itemId: string;
  turnId: string;
  res: FlowResult;
  /** Turn status the run closed with (`done` = a result message arrived). */
  status: string;
  /** Typed result the worker reported. */
  resultKind?: ResultKind;
  stopping: boolean;
  abortCause?: "stale" | "item_age";
  now?: number;
}

/**
 * Apply the policy to a goal item that is still `running` at the end of its run. Returns the verdict when it moved the
 * item (the normal settle is then skipped), or undefined when the normal settle applies (a standalone task, a typed
 * result other than FAILED, a run that ended without a typed report, an owner stop).
 */
export function applyFailurePolicy(a: PolicyInput): FailureVerdict | undefined {
  const { db, res } = a;
  const item = getItem(db, a.itemId);
  if (!item?.parentId || item.status !== "running") return undefined;
  let c: { class: FailureClass; cause: string };
  if (a.status === "done") {
    if (a.resultKind !== "FAILED") return undefined;
    c = { class: "real", cause: "worker_failed" }; // the worker itself reported failure: never retried blindly
  } else {
    c = classifyRunFailure({
      outcome: res.outcome,
      errorText: res.text,
      transient: res.transient,
      abortCause: a.abortCause,
      stopping: a.stopping,
    });
    if (c.class === "owner_stop") return undefined;
  }
  if (c.cause === "resume_failed") setTurnSession(db, a.turnId, ""); // the next start falls back to the brief
  if (c.class === "transient" && item.attempt < AUTO_RESUME_CAP) {
    if (!moveTaskTo(db, item.id, "ready")) return undefined;
    const attempt = bumpAttempt(db, item.id);
    holdUntil(item.id, (a.now ?? Date.now()) + attempt * RESUME_BACKOFF_STEP_MS);
    logEvent(log, "task.auto_resume", { itemId: item.id, cause: c.cause, attempt }, "warn");
    return { action: "resume", ...c, attempt };
  }
  if (!moveTaskTo(db, item.id, "blocked")) return undefined;
  setResultKind(db, item.id, "FAILED");
  // A transient failure that used up its resumes is a real failure for the lead.
  const held =
    c.class === "transient" ? { class: "real" as const, cause: `resume_cap:${c.cause}` } : c;
  logEvent(log, "task.held", { itemId: item.id, ...held, attempt: item.attempt }, "warn");
  return { action: "hold", ...held, attempt: item.attempt };
}

/**
 * The `closeTurn` hook of one worker run: applies the policy with what the run knows at its end (typed report, shutdown,
 * the watchdog's abort cause, read from the still-registered live run) and keeps the verdict for the end event.
 */
export function workerFailurePolicy(a: {
  db: Database;
  itemId: string;
  turnId: string;
  resultKind: () => ResultKind | undefined;
  stopping: () => boolean;
  verdict: { current?: FailureVerdict };
}): (res: FlowResult, status: string) => boolean {
  return (res, status) => {
    a.verdict.current = applyFailurePolicy({
      db: a.db,
      itemId: a.itemId,
      turnId: a.turnId,
      res,
      status,
      resultKind: a.resultKind(),
      stopping: a.stopping(),
      abortCause: runOfTask(a.itemId)?.abortCause,
    });
    return !!a.verdict.current;
  };
}
