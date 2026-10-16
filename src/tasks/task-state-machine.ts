import type { TaskState } from "./task-contracts";

/*
 * Persisted states of an owned task. The doc states CANDIDATE_SELECTED / PREFLIGHT / RE_ROUTE are per-turn
 * (trace spans), only `TaskState.status` is stored.
 */
type Status = TaskState["status"];

/**
 * Allowed moves, one row per state (data). A terminal state (completed / failed / cancelled) has no exit.
 * Item flow: pending -> ready -> running -> waiting_user | blocked | completed | failed | cancelled.
 */
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  open: ["running", "waiting_user", "cancelled", "failed"],
  pending: ["ready", "running", "blocked", "cancelled", "failed"],
  ready: ["running", "blocked", "cancelled", "failed"],
  running: ["waiting_user", "blocked", "completed", "failed", "cancelled"],
  // A waiting task is continued (running), or the owner drops it.
  waiting_user: ["running", "ready", "completed", "failed", "cancelled"],
  // Blocked (e.g. NEEDS_PLANNING) is released back to the queue, or dropped.
  blocked: ["pending", "ready", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** True when `from -> to` is allowed (staying in the same state is always allowed). */
export const canTransition = (from: Status, to: Status): boolean =>
  from === to || TRANSITIONS[from].includes(to);
