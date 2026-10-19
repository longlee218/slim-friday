import type { Database } from "bun:sqlite";
import { logger, tryLog } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { STATUS_OF_RESULT } from "../../roles/typed-result";
import { getItem, type ResultKind } from "../../storage/owned-item-store";
import { finishTurn, turnStatusOf } from "../../storage/run-store";
import { appendEvent } from "../../storage/thread-event-store";
import { moveTaskTo, settleTaskAfterTurn } from "../../tasks/task-resolver";
import type { ArtifactScope } from "../turns/result-file-save";
import { saveResultFile } from "../turns/result-file-save";
import type { FlowResult } from "../turns/turn-result";

/* Crash path of a detached worker run (the run threw, its close step threw, or the reaper gave up on it): the turn row
   is closed and the item never stays `running` with no live run. A stored report is kept; otherwise the failure policy
   decides (transient = resume, anything else = held for the lead). */

/** Logger of this module. */
const log = logger.child({ module: "detached-crash" });

/** What the recovery needs from the run. */
interface CrashRun {
  threadId: string;
  turnId: string;
  /** Owned task (goal item) of the run. */
  taskId: string;
  /** Typed result the worker reported before the crash. */
  resultKind: () => ResultKind | undefined;
  /** Where a kept report's result file goes (agent home + channel scope) and its title: the crash must not lose the artifact. */
  agentHome?: string;
  artifactScope?: ArtifactScope;
  resultTitle?: () => string | undefined;
  /** Goal-item failure policy (see `closeTurn`). */
  failurePolicy?: (res: FlowResult, status: string) => boolean;
}

/**
 * Close the turn row and settle the item of a crashed run. Returns true for a goal item: its end event (`failure` with
 * key, class and error, or `result`) is then the run's `onSettled`; false means the caller appends the bare crash event.
 * Never throws (the db may be the thing that crashed).
 */
export function recoverCrashedRun(db: Database, run: CrashRun, err: unknown): boolean {
  let goalItem = false;
  tryLog(log, "crash recovery failed", () => {
    // A close step that crashed after `finishRun` left the row closed: only a still-running row is failed here.
    if (turnStatusOf(db, run.turnId) === "running") finishTurn(db, run.turnId, "failed");
    const item = getItem(db, run.taskId);
    if (item && item.status !== "running") return; // already settled (or cancelled): nothing to move
    const kind = run.resultKind();
    if (item?.parentId && kind && kind !== "FAILED") {
      moveTaskTo(db, item.id, STATUS_OF_RESULT[kind]); // the report was stored: the crash must not erase it
      if (run.agentHome)
        // ... nor its result file (`Orchestrate forward` reads the path)
        saveResultFile(
          db,
          run.agentHome,
          run.artifactScope,
          run.turnId,
          run.threadId,
          "failed",
          "error",
          "",
          kind,
          run.resultTitle?.(),
        );
      return;
    }
    // Always `error`, even after a watchdog abort: a crash that reached here is a real failure (a force-closed run may
    // still be alive, so a resume would race it). An aborted-but-returned run never gets here (`run-stream` maps it).
    const res: FlowResult = { text: errText(err), outcome: "error", sessionId: undefined };
    if (item?.parentId && run.failurePolicy?.(res, "failed")) return;
    settleTaskAfterTurn(db, run.turnId, "failed");
  });
  tryLog(log, "crash item read failed", () => {
    goalItem = !!getItem(db, run.taskId)?.parentId;
  });
  return goalItem;
}

/** The crash event of a run whose item has no end event (a standalone task, or no item row): the lead still hears of it. */
export function appendCrashEvent(db: Database, run: CrashRun, err: unknown): void {
  tryLog(log, "failure event append failed", () => {
    const item = getItem(db, run.taskId);
    appendEvent(db, {
      id: `failure:${run.turnId}`,
      threadId: run.threadId,
      taskId: run.taskId,
      ...(item && { itemId: item.id }),
      kind: "failure",
      payload: { error: errText(err), ...(item?.itemKey && { key: item.itemKey }) },
    });
  });
}
