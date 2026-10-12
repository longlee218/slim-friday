import type { Database } from "bun:sqlite";
import { logger } from "../../observability/logger";
import { ROLES } from "../../roles/role-registry";
import { type GateState, stateOfApprovalTool, stateOfGate } from "../engine/gates";

/**
 * State of a thread, DERIVED from its rows (no stored state, no new status values):
 * - `idle`: no task, or the last one was cancelled / failed / timed out / interrupted
 * - `awaiting_plan_approval`: the task waits on the plan gate
 * - `running`: a task runs (also while it waits for an answer)
 * - `awaiting_tool_approval`: the task waits on the owner's approval of a tool call (not a gate); steers still apply
 * - `awaiting_result`: no gate sets it since Rev 15 phase 3 (the agent delivers); the intent layer still knows it until phase 5
 * - `awaiting_confirmation`: the task waits on an owner-confirm gate (no stage has one yet)
 * - `done`: the last task finished; folds to `idle` (see `isIdleLike`) and the thread ledger describes it
 */
export type ThreadState =
  | "idle"
  | "running"
  | "awaiting_tool_approval"
  | "awaiting_result"
  | "done"
  | GateState;

/** Logger of this module. */
const log = logger.child({ module: "thread-state" });

/* The waiting states come from the gate table (engine/gates.ts): no gate is hard-coded here. */

/** The task's pending approval of a TOOL call (not a gate approval), or undefined: tool name and when it was asked. */
export function pendingToolApproval(
  db: Database,
  turnId: string,
): { tool: string; since: number } | undefined {
  const pending = db
    .query<{ tool: string; since: number }, [string]>(
      "SELECT tool, requested_at AS since FROM approvals WHERE turn_id = ? AND decision = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(turnId);
  return pending && !stateOfApprovalTool(pending.tool) ? pending : undefined;
}

/** The thread's latest task waits on a tool approval: the pending one (reply of a steer, status snapshot), or undefined. */
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

/** Gate state of a task parked in `waiting_approval`: by its pending approval, else by its running stage. */
function waitingState(db: Database, turnId: string): ThreadState {
  const pending = db
    .query<{ tool: string }, [string]>(
      "SELECT tool FROM approvals WHERE turn_id = ? AND decision = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(turnId);
  if (pending) return stateOfApprovalTool(pending.tool) ?? "awaiting_tool_approval";
  // No pending row (the decision just landed): fall back to the gate of the stage that is running.
  const stage = db
    .query<{ role: string; name: string }, [string]>(
      `SELECT t.role AS role, s.name AS name FROM stages s JOIN turns t ON t.id = s.turn_id
       WHERE s.turn_id = ? AND s.status = 'running' ORDER BY s.idx DESC LIMIT 1`,
    )
    .get(turnId);
  const role = stage ? ROLES[stage.role] : undefined;
  if (stage && !role) {
    // A row of a role this build does not know (renamed / removed): idle-like, never a crash.
    // log schema key kept (taskId)
    log.warn({ role: stage.role, taskId: turnId }, "unknown role in a task row");
    return "idle";
  }
  const gate = role?.stages.find((s) => s.name === stage?.name)?.gate;
  return stateOfGate(gate ?? undefined) ?? "running";
}

/** Derive the state of `threadId` from its latest task (and that task's approvals / stages). */
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

/** `done` folds to `idle`: both route to the assistant, which then sees the thread ledger. */
export const isIdleLike = (s: ThreadState): boolean => s === "idle" || s === "done";

/** The thread waits on an owner gate (approval buttons): plan, result or confirmation. */
export const isGateState = (s: ThreadState): boolean =>
  s !== "idle" && s !== "running" && s !== "awaiting_tool_approval" && s !== "done";

/** A task works: it runs, or waits on a tool approval. Steers and side questions treat both the same. */
export const isWorking = (s: ThreadState): boolean =>
  s === "running" || s === "awaiting_tool_approval";
