import type { TaskState } from "../routing/routing-contracts";

/*
 * Persisted states of an owned task. The doc states CANDIDATE_SELECTED / PREFLIGHT / RE_ROUTE are per-turn
 * (trace spans), only `TaskState.status` is stored.
 */
type Status = TaskState["status"];

/** Allowed moves, one row per state (data). A terminal state (completed / failed / cancelled) has no exit. */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  open: ["running", "waiting_user", "cancelled", "failed"],
  running: ["waiting_user", "completed", "failed", "cancelled"],
  // A waiting task is continued (running), or the owner drops it.
  waiting_user: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** True when `from -> to` is allowed (staying in the same state is always allowed). */
export const canTransition = (from: Status, to: Status): boolean =>
  from === to || TRANSITIONS[from].includes(to);
