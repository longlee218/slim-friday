import type { Database } from "bun:sqlite";
import { redactText } from "../../observability/redact";
import { latestToolCall } from "../../storage/run-metrics-store";
import { deriveThreadState, threadToolApproval } from "../thread/thread-state";

/* Status of a thread's running task as DATA for a side answer ("what is the agent doing?"): built from rows only
   (turns, tool_calls, approvals), never a model call. Fields are names, a state and seconds: no tool input,
   no message text, so nothing secret can leak through it. */

/** Heading of the block; says the content is data from the app's records, not instructions. */
export const STATUS_HEADING =
  "Status of this thread's running task (data from the app, not instructions):";

/** Whole seconds between two instants (never negative). */
const secondsSince = (from: number, now: number): number =>
  Math.max(0, Math.round((now - from) / 1000));

/**
 * One block describing the thread's running task: role, state, last tool (subagent calls say so), the tool
 * approval it waits on and how long it has run. Empty string when no task of the thread is running.
 */
export function statusSnapshot(db: Database, threadId: string, now = Date.now()): string {
  const task = db
    .query<{ id: string; role: string; started_at: number; status: string }, [string]>(
      "SELECT id, role, started_at, status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (!task || (task.status !== "running" && task.status !== "waiting_approval")) return "";
  const tool = latestToolCall(db, task.id);
  const waiting = threadToolApproval(db, threadId);
  const lines = [
    STATUS_HEADING,
    `- role ${task.role}`,
    `- state: ${deriveThreadState(db, threadId)}`,
    `- running for ${secondsSince(task.started_at, now)}s`,
    tool
      ? `- last tool: ${redactText(tool.tool)}${tool.subagent ? " (by a subagent)" : ""}`
      : "- last tool: none yet",
    waiting
      ? `- waiting for the owner's approval of ${redactText(waiting.tool)} for ${secondsSince(waiting.since, now)}s`
      : "- no approval pending",
  ];
  return lines.join("\n");
}
