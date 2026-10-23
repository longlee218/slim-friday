import type { Database } from "bun:sqlite";
import { clip, redactText } from "../../observability/redact";
import { getItem } from "../../storage/owned-item-store";
import { turnStartedAt } from "../../storage/run-store";
import { appendEvent } from "../../storage/thread-event-store";
import { resultOfRun } from "../messages/task-messages";
import type { FailureVerdict } from "./failure-policy";
import type { ReportSink } from "./report-sink";

/** Chars of the clip of blocker and crash text in the end event. */
const STEP_CHARS = 600;

/**
 * The end event of a worker run, from the task's settled status: completed = `result`, failed = `failure`, blocked =
 * `blocked` (a held item, blocked with result FAILED, is a `failure`: payload `class`, `cause`, `attempt`), waiting on
 * the owner = `question`. A resumed item (back to `ready`) is news to nobody; a cancelled task is too, unless its worker
 * had already reported COMPLETED (the cancel raced the report: effects may exist, so the result is announced anyway).
 * Ids are stable per turn. `crashError` = the run crashed (or was force-closed): it rides on the one end event.
 */
export function emitEndEvent(
  db: Database,
  threadId: string,
  itemId: string,
  turnId: string,
  report?: ReportSink["report"],
  verdict?: FailureVerdict,
  crashError?: string,
  blocker?: ReportSink["blocker"],
  imageCount = 0,
  fileCount = 0,
): void {
  const it = getItem(db, itemId);
  if (!it) return;
  const kind =
    it.status === "completed"
      ? "result"
      : it.status === "failed"
        ? "failure"
        : it.status === "blocked"
          ? it.resultKind === "FAILED"
            ? "failure"
            : "blocked"
          : it.status === "waiting_user"
            ? "question"
            : it.status === "cancelled" && report?.status === "COMPLETED"
              ? "result"
              : undefined;
  if (!kind) return;
  // The result message of THIS run; an empty reply writes none, then the older result is named as such.
  const result = resultOfRun(db, it.id, turnStartedAt(db, turnId) ?? 0);
  appendEvent(db, {
    id: `${kind}:${turnId}`,
    threadId,
    taskId: it.parentId ?? it.id,
    itemId: it.id,
    kind,
    payload: {
      key: it.itemKey,
      status: it.status,
      resultKind: it.resultKind,
      excerpt: it.resultExcerpt,
      resultMessage: result.ref, // the full result text is this message (TaskBoard read)
      ...(result.earlierRef && { earlierResultMessage: result.earlierRef }), // this run left none: an older run's result
      // Deliverable files the report names: `Orchestrate forward verbatim` makes their artifacts.
      ...(fileCount > 0 && { files: fileCount }),
      ...(verdict?.action === "hold" && {
        class: verdict.class,
        cause: verdict.cause,
        attempt: verdict.attempt,
      }),
      // `Report blocker`: what blocks the run and what it needs (answer, access, decision, other).
      ...(blocker && {
        blocker: {
          needs: blocker.needs,
          reason: clip(redactText(blocker.reason), STEP_CHARS),
          ...(blocker.messageId && { messageId: blocker.messageId }),
        },
      }),
      // Screenshots of the report, posted to the thread by code when the run ended: the lead need not (and cannot) send them.
      ...(imageCount > 0 && { screenshotsPosted: imageCount }),
      ...(crashError && { error: clip(redactText(crashError), STEP_CHARS) }),
      ...(report && { summary: report.summary, requests: report.requests }),
    },
  });
}
