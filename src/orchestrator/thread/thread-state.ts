import type { Database } from "bun:sqlite";
import { OWNER_CONFIRM_APPROVAL } from "../engine/owner-confirm";

/**
 * State of a thread, DERIVED from its rows (no stored state, no new status values):
 * - `idle`: no task, or the last one was cancelled / failed / timed out / interrupted
 * - `running`: a task runs
 * - `awaiting_owner`: the task waits on the owner: a tool-call approval or an AskUserQuestion (the plan approval is one); steers still apply
 * - `awaiting_confirmation`: the task waits on an owner-confirm yes/no (effort `max`, an Opus escalation)
 * - `done`: the last task finished; folds to `idle` (see `isIdleLike`) and the thread ledger describes it
 */
export type ThreadState = "idle" | "running" | "awaiting_owner" | "awaiting_confirmation" | "done";

/** The task's pending approval of a TOOL call or question (not an owner-confirm), or undefined: tool name and when it was asked. */
export function pendingToolApproval(
  db: Database,
  turnId: string,
): { tool: string; since: number } | undefined {
  const pending = db
    .query<{ tool: string; since: number }, [string]>(
      "SELECT tool, requested_at AS since FROM approvals WHERE turn_id = ? AND decision = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(turnId);
  return pending && pending.tool !== OWNER_CONFIRM_APPROVAL ? pending : undefined;
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

/** State of a task parked in `waiting_approval`: by its pending approval (an owner-confirm, or any other question to the owner). */
function waitingState(db: Database, turnId: string): ThreadState {
  const pending = db
    .query<{ tool: string }, [string]>(
      "SELECT tool FROM approvals WHERE turn_id = ? AND decision = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(turnId);
  if (!pending) return "running"; // no pending row: the decision just landed
  return pending.tool === OWNER_CONFIRM_APPROVAL ? "awaiting_confirmation" : "awaiting_owner";
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
