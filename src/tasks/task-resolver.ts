import type { Database } from "bun:sqlite";
import { excerpt, logEvent, logger } from "../observability/logger";
import { getRole } from "../roles/role-registry";
import {
  casUpdateTask,
  getOwnedTask,
  insertOwnedTask,
  linkTurn,
  ownedTaskOfTurn,
  threadOfTask,
} from "../storage/owned-task-store";
import type { ReasonCode, TaskState } from "./task-contracts";
import { canTransition } from "./task-state-machine";

const log = logger.child({ module: "task-resolver" });

/** Cap of a task `scope` line, chars (same as a ledger line). */
export const SCOPE_CHARS = 160;

/** Open a task owned by a background role. `scope` is redacted, one line, clipped. Returns the new task. */
export function openTask(
  db: Database,
  t: {
    threadId: string;
    owner: string;
    scope: string;
    traceId: string;
    /** Initial status: `running` when its turn starts now. */
    status?: TaskState["status"];
  },
): TaskState {
  const id = crypto.randomUUID();
  insertOwnedTask(db, {
    id,
    threadId: t.threadId,
    ownerRole: t.owner,
    status: t.status ?? "open",
    scope: excerpt(t.scope, SCOPE_CHARS),
    correlationId: t.traceId,
  });
  const row = getOwnedTask(db, id);
  if (!row) throw new Error(`owned task ${id} missing right after insert`);
  return row;
}

/**
 * Move a task to another owner role (CAS; one retry on a version conflict, re-reading the task).
 * Logs `task.owner_changed` with from / to / reasonCode / traceId. Returns false when both attempts lost the race.
 */
export function changeOwner(
  db: Database,
  task: TaskState,
  to: string,
  reasonCode: ReasonCode,
  traceId: string,
): boolean {
  // Only a background role may own a task.
  if (!getRole(to).background) {
    log.warn({ ownedTaskId: task.taskId, to }, "task.owner_change_refused");
    return false;
  }
  let current: TaskState | undefined = task;
  for (let attempt = 0; attempt < 2 && current; attempt++) {
    if (casUpdateTask(db, current.taskId, current.version, { ownerRole: to })) {
      logEvent(log, "task.owner_changed", {
        ownedTaskId: current.taskId,
        from: current.ownerAgentId,
        to,
        reasonCode,
        traceId,
      });
      return true;
    }
    current = getOwnedTask(db, task.taskId); // lost the race: retry on the fresh version
  }
  return false;
}

/** Move a task to `status` (CAS, one retry). Returns false for a forbidden move (e.g. out of a terminal state) or a lost race. */
export function moveTaskTo(db: Database, taskId: string, status: TaskState["status"]): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = getOwnedTask(db, taskId);
    if (!cur) return false;
    if (!canTransition(cur.status, status)) return false;
    if (casUpdateTask(db, taskId, cur.version, { status })) return true;
  }
  return false;
}

/**
 * Link a freshly created turn to an owned task. Caller has already checked the role is a background one.
 * Order: the task named by the caller, else the task of the turn being resumed (it goes back to `running`),
 * else a new task owned by `owner`.
 */
export function attachTurnToTask(
  db: Database,
  t: {
    turnId: string;
    threadId: string;
    owner: string;
    scope: string;
    traceId: string;
    ownedTaskId?: string;
  },
): string {
  const existing = t.ownedTaskId;
  const task = existing ? getOwnedTask(db, existing) : undefined;
  // A task of another thread is never adopted.
  if (task && threadOfTask(db, task.taskId) !== t.threadId)
    log.warn({ ownedTaskId: task.taskId, threadId: t.threadId }, "task.link_refused");
  else if (task) {
    // A finished task is not reopened: the new turn gets a task of its own below.
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
      // The turn's role takes the task over (logs task.owner_changed).
      if (task.ownerAgentId !== t.owner)
        changeOwner(db, task, t.owner, "EXPLICIT_SWITCH", t.traceId);
      if (!moveTaskTo(db, task.taskId, "running"))
        log.warn({ ownedTaskId: task.taskId, from: task.status }, "task.resume_move_failed");
      linkTurn(db, t.turnId, task.taskId);
      return task.taskId;
    }
  }
  const fresh = openTask(db, { ...t, status: "running" });
  linkTurn(db, t.turnId, fresh.taskId);
  return fresh.taskId;
}

/** Task status for a final turn status (only background turns are linked). */
const STATUS_OF_TURN: Readonly<Record<string, TaskState["status"]>> = {
  done: "completed",
  failed_resumable: "waiting_user",
  interrupted: "waiting_user",
  failed: "failed",
  timeout: "failed",
  cancelled: "cancelled",
};

/**
 * Turn ended with `turnStatus`: settle its task. No-op for an unlinked turn or a status that keeps it running.
 * `undelivered` = the run ended `done` but left no delivery evidence: the task waits for the owner (not completed).
 */
export function settleTaskAfterTurn(
  db: Database,
  turnId: string,
  turnStatus: string,
  undelivered = false,
): void {
  const taskId = ownedTaskOfTurn(db, turnId);
  const next = undelivered && turnStatus === "done" ? "waiting_user" : STATUS_OF_TURN[turnStatus];
  if (taskId && next) moveTaskTo(db, taskId, next);
}
