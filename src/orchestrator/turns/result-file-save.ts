import type { Database } from "bun:sqlite";
import { logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { getItem, goalOf, type ResultKind, setTaskResult } from "../../storage/owned-item-store";
import { getOwnedTask, ownedTaskOfTurn } from "../../storage/owned-task-store";
import { writeTaskResultFile } from "../worker/result-file";

const log = logger.child({ module: "result-file" });

/**
 * A finished turn linked to an owned task: write its result file and record path + excerpt on the task row.
 * No-op for an unlinked turn. Bookkeeping only: a failure is logged and never blocks the reply.
 */
export function saveResultFile(
  db: Database,
  agentHome: string,
  turnId: string,
  turnStatus: string,
  outcome: string,
  reply: string,
  kind?: ResultKind,
): void {
  try {
    const taskId = ownedTaskOfTurn(db, turnId);
    if (!taskId) return;
    // A standalone task is its own goal with the single item "main".
    const written = writeTaskResultFile(agentHome, {
      goalId: goalOf(db, taskId) ?? taskId,
      itemKey: getItem(db, taskId)?.itemKey ?? "main",
      turnStatus,
      outcome,
      taskStatus: getOwnedTask(db, taskId)?.status,
      reply,
    });
    setTaskResult(db, taskId, { ...written, ...(kind && { kind }) });
  } catch (err) {
    log.warn({ err: errText(err) }, "task result file failed");
  }
}
