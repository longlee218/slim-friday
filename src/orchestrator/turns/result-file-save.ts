import type { Database } from "bun:sqlite";
import { writeArtifact } from "../../artifacts/artifact-writer";
import { pathSegment } from "../../artifacts/safe-write";
import { logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { taskStoreArtifacts } from "../../storage/artifact-list-store";
import { getItem, goalOf, type ResultKind, setTaskResult } from "../../storage/owned-item-store";
import { getOwnedTask, ownedTaskOfTurn } from "../../storage/owned-task-store";
import { resultDocument } from "../worker/result-file";

const log = logger.child({ module: "result-file" });

/** Where a run's artifacts go: its space and, when mapped, its channel (yaml name). */
export interface ArtifactScope {
  workspace: string;
  channel?: string;
}

/**
 * A finished turn linked to an owned task: when the run saved no file itself, store its result as an artifact (kind `md`, named from the worker's title) in
 * the run's workspace channel and record path + excerpt on the task row (`ForwardResult` reads that path). Without a
 * scope (no workspace) nothing is written and only the excerpt is kept. No-op for an unlinked turn. Bookkeeping only: a
 * failure is logged and never blocks the reply.
 */
export function saveResultFile(
  db: Database,
  agentHome: string,
  scope: ArtifactScope | undefined,
  turnId: string,
  threadId: string,
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
    const task = getOwnedTask(db, taskId);
    const doc = resultDocument({
      itemKey,
      turnStatus,
      outcome,
      taskStatus: task?.status,
      title,
      reply,
    });
    // A file the run saved itself (SaveArtifact) IS the result: the short summary is no second artifact, the primary
    // saved file (largest) becomes the result path and only the excerpt is kept from the summary.
    const saved = taskStoreArtifacts(db, taskId)[0];
    const written = saved
      ? { path: saved.path }
      : scope
        ? writeArtifact(db, agentHome, {
            ...scope,
            goalId: goalOf(db, taskId) ?? taskId,
            taskId,
            threadId,
            title,
            fallbackName: `result-${pathSegment(itemKey).toLowerCase()}`,
            kind: "md",
            body: doc.text,
            producerRole: task?.ownerAgentId ?? undefined,
          })
        : undefined;
    setTaskResult(db, taskId, {
      path: written?.path ?? null,
      excerpt: doc.excerpt,
      ...(kind && { kind }),
    });
  } catch (err) {
    log.warn({ err: errText(err) }, "task result file failed");
  }
}
