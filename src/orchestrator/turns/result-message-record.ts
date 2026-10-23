import type { Database } from "bun:sqlite";
import { logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { getItem, type ResultKind, setTaskResult } from "../../storage/owned-item-store";
import { ownedTaskOfTurn, threadOfTask } from "../../storage/owned-task-store";
import { postTaskMessage } from "../messages/task-messages";
import type { ReportFile } from "../worker/report-files";
import { resultDocument } from "../worker/result-file";

const log = logger.child({ module: "result-message" });

/** Where a run's artifacts go: its space and, when mapped, its channel (yaml name). */
export interface ArtifactScope {
  workspace: string;
  channel?: string;
}

/**
 * A finished turn linked to an owned task: the run's final reply becomes the task's `result` message (full text, redacted,
 * never cut; an empty reply, as in crash recovery, writes none) and the row keeps the short excerpt and the typed kind.
 * No-op for an unlinked turn. Bookkeeping only: a failure is logged and never blocks the reply.
 */
export function recordTaskResult(
  db: Database,
  turnId: string,
  reply: string,
  kind?: ResultKind,
  title?: string,
  files?: ReportFile[],
): void {
  try {
    const taskId = ownedTaskOfTurn(db, turnId);
    if (!taskId) return;
    const item = getItem(db, taskId);
    const doc = resultDocument({ itemKey: item?.itemKey ?? "main", title, reply }); // a standalone task is its own goal with the single item "main"
    setTaskResult(db, taskId, { excerpt: doc.excerpt, ...(kind && { kind }) });
    const threadId = threadOfTask(db, taskId);
    if (threadId && reply.trim())
      postTaskMessage(db, {
        threadId,
        goalId: item?.parentId ?? taskId,
        taskId,
        author: item?.ownerRole ?? "worker",
        kind: "result",
        text: doc.text,
        ...(files?.length && { files: JSON.stringify(files) }),
      });
  } catch (err) {
    log.warn({ err: errText(err) }, "task result record failed");
  }
}
