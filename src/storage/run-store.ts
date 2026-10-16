import type { Database } from "bun:sqlite";
import { redactText } from "../observability/redact";
import { countsTowardCap, getRole } from "../roles/role-registry";
import { reconcileRunningTasks } from "./owned-task-store";

/** Final status of a turn row. */
export type TurnStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  /** Cut short by a restart/shutdown; the thread gets a Resume offer, then the row becomes cancelled. */
  | "interrupted"
  | "timeout"
  /** A background run that failed with its session saved (budget, transient error); no longer written, old rows are expired at startup. */
  | "failed_resumable";

/** Change a turn's status without ending it (no-op when the row is missing). */
export function setTurnStatus(db: Database, id: string, status: TurnStatus): void {
  db.query("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
}

/** Record the location a turn works in once it is known (a background task starts with "*" until its final `location:` marker names one). */
export function setTurnLocation(db: Database, id: string, location: string): void {
  db.query("UPDATE turns SET location = ? WHERE id = ?").run(location, id);
}

/** Record the Claude session of a turn (reported at `system/init`). */
export function setTurnSession(db: Database, id: string, sessionId: string): void {
  db.query("UPDATE turns SET session_id = ? WHERE id = ?").run(sessionId, id);
}

/** Claude session a turn recorded at `system/init`, or undefined (not started yet / no row). */
export function turnSessionId(db: Database, id: string): string | undefined {
  return (
    db
      .query<{ session_id: string | null }, [string]>("SELECT session_id FROM turns WHERE id = ?")
      .get(id)?.session_id ?? undefined
  );
}

/** Status of a turn row, or "" when the row is missing. */
export function turnStatusOf(db: Database, id: string): string {
  return (
    db.query<{ status: string }, [string]>("SELECT status FROM turns WHERE id = ?").get(id)
      ?.status ?? ""
  );
}

/** Role that owns a turn row, or undefined when the row is missing. */
export function turnRole(db: Database, id: string): string | undefined {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM turns WHERE id = ?")
    .get(id)?.role;
  return role;
}

/** Insert a turn row in `running` state. */
export function insertTurn(
  db: Database,
  t: {
    id: string;
    threadId: string;
    source: string;
    location: string;
    /** Role that runs it: the cap flag is derived from its data. */
    role: string;
    /** Task text of a dispatched task; stored redacted. */
    brief?: string;
    /** How many hand-overs deep the task is (0 = owner-started). */
    hop?: number;
  },
): void {
  // Only background roles that change something count against the concurrency cap (see `countActiveCappedTasks`).
  const role = getRole(t.role);
  db.query(
    `INSERT INTO turns (id, thread_id, source, location, status, started_at, brief, counts_toward_cap, role, kind, hop)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 'single', ?)`,
  ).run(
    t.id,
    t.threadId,
    t.source,
    t.location,
    Date.now(),
    t.brief === undefined ? null : redactText(t.brief),
    countsTowardCap(role) ? 1 : 0,
    role.name,
    t.hop ?? 0,
  );
}

/** Set final status and end time of a turn. */
export function finishTurn(db: Database, id: string, status: TurnStatus): void {
  db.query("UPDATE turns SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
}

/** Mark every still-`running` turn `interrupted` (restart/shutdown) and cancel their pending approvals. */
export function interruptRunningTurns(db: Database): void {
  const now = Date.now();
  db.query(
    "UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status IN ('running', 'waiting_approval')",
  ).run(now);
  // Their owned tasks wait for the owner (a resume or the next message continues them).
  reconcileRunningTasks(db);
  // Buttons of a dead process can never be answered (a resumed run asks again).
  db.query(
    "UPDATE approvals SET decision = 'cancelled', decided_at = ? WHERE decision = 'pending'",
  ).run(now);
}

/** Number of cap-counted tasks currently running or waiting for approval (concurrency cap). */
export function countActiveCappedTasks(db: Database): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM turns WHERE counts_toward_cap = 1 AND status IN ('running', 'waiting_approval')",
    )
    .get()!.n;
}

/** The thread's newest turn (any status), or undefined. */
export function latestTurnOfThread(
  db: Database,
  threadId: string,
): { id: string; role: string; started_at: number; status: string } | undefined {
  return (
    db
      .query<{ id: string; role: string; started_at: number; status: string }, [string]>(
        "SELECT id, role, started_at, status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(threadId) ?? undefined
  );
}

/** The newest turn linked to an owned task, or undefined. */
export function latestTurnOfTask(
  db: Database,
  taskId: string,
): { id: string; ended_at: number | null; started_at: number } | undefined {
  return (
    db
      .query<{ id: string; ended_at: number | null; started_at: number }, [string]>(
        "SELECT id, ended_at, started_at FROM turns WHERE owned_task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(taskId) ?? undefined
  );
}

/** The thread's newest turn that is running (or waits on an approval), with its role. */
export function liveTurnOfThread(
  db: Database,
  threadId: string,
): { id: string; role: string } | undefined {
  return (
    db
      .query<{ id: string; role: string }, [string]>(
        `SELECT id, role FROM turns WHERE thread_id = ? AND status IN ('running', 'waiting_approval')
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) ?? undefined
  );
}

/** Turns of the thread that ended `done`, other than `exceptTurnId`, started at or after `since`. */
export function countDoneTurnsSince(
  db: Database,
  threadId: string,
  exceptTurnId: string,
  since: number,
): number | undefined {
  return db
    .query<{ n: number }, [string, string, number]>(
      "SELECT COUNT(*) AS n FROM turns WHERE thread_id = ? AND id != ? AND status = 'done' AND started_at >= ?",
    )
    .get(threadId, exceptTurnId, since)?.n;
}
