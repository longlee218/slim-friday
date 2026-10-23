import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import type { OwnerLanguage } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import { ownerConfirm } from "../../owner-approval/owner-confirm";
import type { DispatchEnvelope } from "../../policy/envelope";
import type { LeadRuntime, LeadThreadCtx } from "../lead/lead-runtime";
import { artifactCtx, locationRefs } from "../lead/thread-tool-ctx";
import { messageRef } from "../messages/message-ref";
import { postTaskMessage } from "../messages/task-messages";
import type { RoleRunInput } from "../run/role-run-types";
import type { ReportSink } from "./report-sink";
import { setProgress, withWaiting } from "./run-activity";

/** What a worker run binds its tools to. */
interface WorkerToolScope {
  threadId: string;
  goalId: string;
  itemId: string;
  turnId: string;
  role: string;
  language: OwnerLanguage;
  envelope: DispatchEnvelope;
  sink: ReportSink;
  /** The run's granted location (a developer reports files from it). */
  pinned?: { name: string; path: string };
}

/**
 * The ctx parts of a worker's MCP tools; its role's `mcpTools` picks which it gets (a worker has no `lead` part, so
 * it can never hold a lead tool).
 */
export function workerAppCtx(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  s: WorkerToolScope,
): NonNullable<RoleRunInput["appCtx"]> {
  const { db } = rt.deps;
  const { threadId, goalId, itemId } = s;
  return () => ({
    reportSink: s.sink,
    taskBoard: { db, threadId },
    scratchDir: s.envelope.goalDir,
    artifacts: artifactCtx(rt, ctx, threadId, s.role, { goalId, taskId: itemId }),
    // `Report result` files: checked against the granted location (else the scratch dir) and copied under task-files.
    reportFiles: {
      home: rt.deps.config.agentHome,
      // One folder per run (turn): a retry or resume of the item can report the same file name again.
      copyDir: join(workspacePaths(rt.deps.config.agentHome).taskFilesOf(goalId, itemId), s.turnId),
      ...(s.pinned && { granted: { name: s.pinned.name, path: s.pinned.path } }),
    },
    // Report progress: recorded on this task's live run (percent, note, heartbeat).
    progress: (p) => {
      setProgress(db, itemId, p);
      // Every progress report is a stored message too (read through the task board, never pushed into a prompt).
      postTaskMessage(db, {
        threadId,
        goalId,
        taskId: itemId,
        author: s.role,
        kind: "progress",
        text: `${p.percent}%: ${p.note}`,
      });
    },
    // `Report blocker`: the full blocker is a message of this task.
    message: (kind, text) =>
      messageRef(
        postTaskMessage(db, { threadId, goalId, taskId: itemId, author: s.role, kind, text }),
      ),
    // Effect tools: bound to the run's envelope.
    effects: {
      db,
      threadId,
      goalId,
      itemId,
      envelope: s.envelope,
      locations: locationRefs(ctx),
      agentHome: rt.deps.config.agentHome,
      // R4 and over-bound asks go to the owner (fail closed). The run idles meanwhile: the watchdog skips it.
      confirm: (summary) =>
        withWaiting(db, itemId, () =>
          ownerConfirm(rt.deps.approvals, {
            kind: "effect",
            turnId: s.turnId,
            threadId,
            summary,
            language: s.language,
          }),
        ),
      run: spawnRunner,
    },
  });
}
