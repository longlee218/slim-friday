import type { Database } from "bun:sqlite";
import { redactText } from "../observability/redact";
import { canonicalRoleName } from "../roles/role-aliases";
import { countsTowardCap, getRole, turnTypeOf } from "../roles/role-registry";
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

/** Record the Claude session of a turn (reported at `system/init`) and the cwd it runs in. */
export function setTurnSession(db: Database, id: string, sessionId: string, cwd: string): void {
  db.query("UPDATE turns SET session_id = ?, session_cwd = ? WHERE id = ?").run(sessionId, cwd, id);
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
  return role === undefined ? undefined : canonicalRoleName(role); // an old-name row reads as the current role
}

/** Insert a turn row in `running` state. */
export function insertTurn(
  db: Database,
  t: {
    id: string;
    threadId: string;
    source: string;
    location: string;
    /** Role that runs it: `type` and the cap flag are derived from its data (never from a type argument). */
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
    `INSERT INTO turns (id, thread_id, source, location, type, status, started_at, brief, counts_toward_cap, role, kind, hop)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 'single', ?)`,
  ).run(
    t.id,
    t.threadId,
    t.source,
    t.location,
    turnTypeOf(role),
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
