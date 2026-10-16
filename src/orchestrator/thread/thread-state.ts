import type { Database } from "bun:sqlite";

/**
 * State of a thread, DERIVED from its rows (no stored state, no new status values):
 * - `idle`: no task, or the last one was cancelled / failed / timed out / interrupted
 * - `running`: a task runs
 * - `awaiting_owner`: the task waits on the owner: a tool-call approval, a yes/no confirm or an AskUserQuestion (the plan approval is one); steers still apply
 * - `done`: the last task finished; folds to `idle` (see `isIdleLike`) and the thread ledger describes it
 */
export type ThreadState = "idle" | "running" | "awaiting_owner" | "done";

/** The task's pending approval of a tool call, confirm or question, or undefined: tool name and when it was asked. */
export function pendingToolApproval(
  db: Database,
  turnId: string,
): { tool: string; since: number } | undefined {
  const pending = db
    .query<{ tool: string; since: number }, [string]>(
      "SELECT tool, requested_at AS since FROM approvals WHERE turn_id = ? AND decision = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(turnId);
  return pending ?? undefined;
}

/** The thread's latest task waits on a tool approval or question: the pending one (reply of a steer, status snapshot), or undefined. */
export function threadToolApproval(
  db: Database,
  threadId: string,
): { tool: string; since: number } | undefined {
  const last = db
    .query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  return last?.status === "waiting_approval" ? pendingToolApproval(db, last.id) : undefined;
}

/** State of a task parked in `waiting_approval`: `awaiting_owner` while an approval is pending, else `running` (the decision just landed). */
function waitingState(db: Database, turnId: string): ThreadState {
  return pendingToolApproval(db, turnId) ? "awaiting_owner" : "running";
}

/** Derive the state of `threadId` from its latest task (and that task's approvals). */
export function deriveThreadState(db: Database, threadId: string): ThreadState {
  const last = db
    .query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (!last) return "idle";
  if (last.status === "running") return "running";
  if (last.status === "waiting_approval") return waitingState(db, last.id);
  return last.status === "done" ? "done" : "idle";
}

/** `done` folds to `idle`: both go to the lead, which then sees the thread ledger. */
export const isIdleLike = (s: ThreadState): boolean => s === "idle" || s === "done";
