import type { TaskState } from "./task-contracts";

/*
 * Persisted states of an owned task. The doc states CANDIDATE_SELECTED / PREFLIGHT / RE_ROUTE are per-turn
 * (trace spans), only `TaskState.status` is stored.
 */
type Status = TaskState["status"];

/**
 * Allowed moves, one row per state (data). A terminal state (completed / failed / cancelled) has no exit.
 * Item flow: pending -> ready -> running -> waiting_user | blocked | completed | failed | cancelled; a transient failure
 * goes running -> ready again, a failed goal item waits `blocked` (held) for the teammate's retry or cancel.
 */
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  open: ["running", "waiting_user", "cancelled", "failed"],
  pending: ["ready", "running", "blocked", "cancelled", "failed"],
  ready: ["running", "blocked", "cancelled", "failed"],
  // running -> ready: an interrupted goal item is resumed automatically (same session, see failure-policy.ts).
  running: ["ready", "waiting_user", "blocked", "completed", "failed", "cancelled"],
  // A waiting task is continued (running), or the owner drops it; past the item age limit it is held (blocked).
  waiting_user: ["running", "ready", "blocked", "completed", "failed", "cancelled"],
  // Blocked (e.g. NEEDS_PLANNING) is released back to the queue, or dropped.
  blocked: ["pending", "ready", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** True when `from -> to` is allowed (staying in the same state is always allowed). */
export const canTransition = (from: Status, to: Status): boolean =>
  from === to || TRANSITIONS[from].includes(to);
