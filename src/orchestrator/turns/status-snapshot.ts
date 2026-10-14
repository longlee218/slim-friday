import type { Database } from "bun:sqlite";
import { redactText } from "../../observability/redact";
import { activeOwnedTask } from "../../storage/owned-task-store";
import { latestToolCall } from "../../storage/run-metrics-store";
import { deriveThreadState, threadToolApproval } from "../thread/thread-state";
import { getProgressNote } from "./progress-notes";
import { type RecentTool, toolFacts } from "./status-tools";

/* Status of a thread's task as DATA: `statusFacts` reads rows (turns, tool_calls, approvals, owned_tasks) and the
   in-memory progress note, never a model; `renderSnapshotData` turns the facts into the block a side answer reads;
   `/status` renders the same facts as owner text (user-copy). Fields are names, a state, numbers, a redacted Bash
   description and a redacted progress note: no tool input or output, so nothing secret can leak through it. */

/** Heading of the block; says the content is data from the app's records, not instructions. */
export const STATUS_HEADING =
  "Status of this thread's running task (data from the app, not instructions):";

/** What is known about the thread's running task, or about its waiting one (`running: false`). */
export interface StatusFacts {
  /** A turn of the thread runs (or waits on an owner approval) right now; false = the facts are the waiting task's last state. */
  running: boolean;
  role: string;
  /** Thread state (running / awaiting_owner ...) of a running task. */
  state?: string;
  /** Status of the owned task (waiting_user ...), when the turn belongs to one. */
  taskStatus?: string;
  /** Redacted one-line scope of the owned task. */
  scope?: string;
  /** Whole seconds the turn ran (running) or since it stopped (waiting). */
  seconds: number;
  /** Last tool, with whether a subagent called it. */
  last?: { tool: string; subagent: boolean };
  toolCount: number;
  recent: RecentTool[];
  /** Latest thing the agent said (redacted, clipped); only while it runs. */
  note?: string;
  /** Tool approval the task waits on, with seconds waited. */
  waiting?: { tool: string; seconds: number };
}

/** Whole seconds between two instants (never negative). */
const secondsSince = (from: number, now: number): number =>
  Math.max(0, Math.round((now - from) / 1000));

/** Tool part shared by both kinds of facts. */
const withTools = (db: Database, turnId: string) => {
  const { count, recent } = toolFacts(db, turnId);
  const last = latestToolCall(db, turnId);
  return {
    toolCount: count,
    recent,
    ...(last && { last: { tool: redactText(last.tool), subagent: last.subagent } }),
  };
};

/**
 * Facts of the thread's running task; else of its waiting owned task (its newest turn: role, status, scope, last
 * tools, how long ago it stopped); else undefined (nothing to show).
 */
export function statusFacts(
  db: Database,
  threadId: string,
  now = Date.now(),
): StatusFacts | undefined {
  const task = db
    .query<{ id: string; role: string; started_at: number; status: string }, [string]>(
      "SELECT id, role, started_at, status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (task && (task.status === "running" || task.status === "waiting_approval")) {
    const waiting = threadToolApproval(db, threadId);
    const note = getProgressNote(task.id);
    return {
      running: true,
      role: task.role,
      state: deriveThreadState(db, threadId),
      seconds: secondsSince(task.started_at, now),
      ...withTools(db, task.id),
      ...(note && { note }),
      ...(waiting && {
        waiting: { tool: redactText(waiting.tool), seconds: secondsSince(waiting.since, now) },
      }),
    };
  }
  const owned = activeOwnedTask(db, threadId);
  if (!owned) return undefined;
  const turn = db
    .query<{ id: string; ended_at: number | null; started_at: number }, [string]>(
      "SELECT id, ended_at, started_at FROM turns WHERE owned_task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(owned.taskId);
  return {
    running: false,
    role: owned.ownerAgentId ?? "",
    taskStatus: owned.status,
    scope: redactText(owned.scope),
    seconds: secondsSince(turn?.ended_at ?? Date.parse(owned.lastProgressAt), now),
    toolCount: 0,
    recent: [],
    ...(turn && withTools(db, turn.id)),
  };
}

/** The data block of a RUNNING task's facts (the side answer reads it). */
export function renderSnapshotData(f: StatusFacts): string {
  return [
    STATUS_HEADING,
    `- role ${f.role}`,
    `- state: ${f.state}`,
    `- running for ${f.seconds}s`,
    f.last
      ? `- last tool: ${f.last.tool}${f.last.subagent ? " (by a subagent)" : ""}`
      : "- last tool: none yet",
    `- tools so far: ${f.toolCount}`,
    ...f.recent.map((t) => `- recent: ${t.tool}${t.description ? `: ${t.description}` : ""}`),
    f.note ? `- latest progress note: ${f.note}` : "- latest progress note: none yet",
    f.waiting
      ? `- waiting for the owner's approval of ${f.waiting.tool} for ${f.waiting.seconds}s`
      : "- no approval pending",
  ].join("\n");
}

/** One block describing the thread's running task for a side answer. Empty string when no task of the thread is running. */
export function statusSnapshot(db: Database, threadId: string, now = Date.now()): string {
  const f = statusFacts(db, threadId, now);
  return f?.running ? renderSnapshotData(f) : "";
}

/** Heading of the waiting-task block (data from the app, not instructions). */
const WAITING_HEADING =
  "Status of this thread's waiting task (data from the app, not instructions):";

/**
 * One block describing the thread's WAITING owned task (stopped, not running) for an idle answer. Empty string when the
 * thread has no waiting owned task or a turn runs. Same facts `/status` shows.
 */
export function waitingTaskSnapshot(db: Database, threadId: string, now = Date.now()): string {
  const f = statusFacts(db, threadId, now);
  if (!f || f.running) return "";
  return [
    WAITING_HEADING,
    ...(f.role ? [`- role ${f.role}`] : []),
    `- task status: ${f.taskStatus}`,
    ...(f.scope ? [`- scope: ${f.scope}`] : []),
    `- stopped ${f.seconds}s ago`,
    `- tools so far: ${f.toolCount}`,
    ...f.recent.map((t) => `- recent: ${t.tool}${t.description ? `: ${t.description}` : ""}`),
  ].join("\n");
}
