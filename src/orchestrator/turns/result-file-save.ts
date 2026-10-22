import type { Database } from "bun:sqlite";
import { logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { taskStoreArtifacts } from "../../storage/artifact-list-store";
import { getItem, type ResultKind, setTaskResult } from "../../storage/owned-item-store";
import { getOwnedTask, ownedTaskOfTurn } from "../../storage/owned-task-store";
import { resultDocument } from "../worker/result-file";

const log = logger.child({ module: "result-file" });

/** Where a run's artifacts go: its space and, when mapped, its channel (yaml name). */
export interface ArtifactScope {
  workspace: string;
  channel?: string;
}

/**
 * A finished turn linked to an owned task: record its result on the task row. A file the run saved itself (SaveArtifact) IS
 * the result (its primary, the largest, becomes the result path); when it saved none, its redacted report is kept as text on
 * the row and no artifact is written (a status report is not a deliverable; `Orchestrate forward` posts the text). The
 * excerpt is always kept. No-op for an unlinked turn. Bookkeeping only: a failure is logged and never blocks the reply.
 */
export function saveResultFile(
  db: Database,
  turnId: string,
  turnStatus: string,
  outcome: string,
  reply: string,
  kind?: ResultKind,
  title?: string,
): void {
  try {
    const taskId = ownedTaskOfTurn(db, turnId);
    if (!taskId) return;
    const itemKey = getItem(db, taskId)?.itemKey ?? "main"; // a standalone task is its own goal with the single item "main"
    const doc = resultDocument({
      itemKey,
      turnStatus,
      outcome,
      taskStatus: getOwnedTask(db, taskId)?.status,
      title,
      reply,
    });
    const saved = taskStoreArtifacts(db, taskId)[0];
    setTaskResult(db, taskId, {
      path: saved?.path ?? null,
      excerpt: doc.excerpt,
      text: saved || !reply.trim() ? null : doc.reading, // an empty reply (crash recovery) leaves no bare heading to forward
      ...(kind && { kind }),
    });
  } catch (err) {
    log.warn({ err: errText(err) }, "task result file failed");
  }
}
