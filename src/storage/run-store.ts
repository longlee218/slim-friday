import type { Database } from "bun:sqlite";
import type { TaskClass } from "../config/model-routing";
import { redactText } from "../observability/redact";
import { getRole, turnTypeOf } from "../roles/role-registry";
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
  /** A background run that failed with its session saved (budget, transient error): `/go` continues that session (Rev 12). */
  | "failed_resumable";

/** Change a turn's status without ending it (no-op when the row is missing). */
export function setTurnStatus(db: Database, id: string, status: TurnStatus): void {
  db.query("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
}

/** Record the repo a turn works in once it is known (a background task starts with "*" until its final `repo:` marker names one). */
export function setTurnRepo(db: Database, id: string, repo: string): void {
  db.query("UPDATE turns SET repo = ? WHERE id = ?").run(repo, id);
}

/** Nothing is left to resume in this thread (no saved session): its `failed_resumable` task becomes `failed`. */
export function dropResumable(db: Database, threadId: string): boolean {
  // An `interrupted` task that was resumed is taken over too (no second restart notice).
  db.query(
    "UPDATE turns SET status = 'cancelled' WHERE thread_id = ? AND status = 'interrupted'",
  ).run(threadId);
  return (
    db
      .query(
        "UPDATE turns SET status = 'failed' WHERE thread_id = ? AND status = 'failed_resumable'",
      )
      .run(threadId).changes > 0
  );
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

/** Latest turn of a thread with the session it recorded (what Resume continues), or null. */
export function latestTurnSession(
  db: Database,
  threadId: string,
): {
  id: string;
  status: string;
  repo: string;
  /** Role that ran it (a Resume starts the same role again). */
  role: string;
  sessionId: string | null;
  cwd: string | null;
  /** The task's last run ended on its budget (`go +<usd>` may resume it). */
  budgetStopped: boolean;
} | null {
  const row = db
    .query<
      {
        id: string;
        status: string;
        repo: string;
        role: string;
        sessionId: string | null;
        cwd: string | null;
        outcome: string | null;
      },
      [string]
    >(
      `SELECT id, status, repo, role, session_id AS sessionId, session_cwd AS cwd,
         (SELECT r.outcome FROM runs r WHERE r.turn_id = turns.id ORDER BY r.rowid DESC LIMIT 1) AS outcome
       FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
  if (!row) return null;
  const { outcome, ...rest } = row;
  return { ...rest, budgetStopped: outcome === "max_budget" };
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
  return db.query<{ role: string }, [string]>("SELECT role FROM turns WHERE id = ?").get(id)?.role;
}

/** Insert a turn row in `running` state. */
export function insertTurn(
  db: Database,
  t: {
    id: string;
    threadId: string;
    source: string;
    repo: string;
    /** Role that runs it: `type` and the cap flag are derived from its data (never from a type argument). */
    role: string;
    /** Task text of a dispatched task; stored redacted. */
    brief?: string;
    /** Task class (owner prefix / proposal); null = standard. */
    cls?: TaskClass;
    /** Proposal this task was started from. */
    proposalId?: string;
    /** Turn that proposed this one, and how many hand-overs deep it is (0 = owner-started). */
    parentTurnId?: string;
    hop?: number;
    /** The task continues a `failed_resumable` or interrupted one (kind `resume`, `parentTurnId` = that task): its budget ceiling is shared. */
    resume?: boolean;
  },
): void {
  // Only background roles count against the concurrency cap (see `countActiveCappedTasks`).
  const role = getRole(t.role);
  db.query(
    `INSERT INTO turns (id, thread_id, source, repo, type, status, started_at, brief, class, proposal_id, counts_toward_cap, role, kind, parent_turn_id, hop)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.threadId,
    t.source,
    t.repo,
    turnTypeOf(role),
    Date.now(),
    t.brief === undefined ? null : redactText(t.brief),
    t.cls ?? null,
    t.proposalId ?? null,
    role.background ? 1 : 0,
    role.name,
    // `kind` is NOT NULL (default 'staged' before v4): a role run is one run, `single`; a continuation is `resume`.
    t.resume ? "resume" : "single",
    t.parentTurnId ?? null,
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

/** Threads that have an interrupted task (each needs one Resume notice). */
export function listInterruptedThreads(db: Database): string[] {
  return db
    .query<{ thread_id: string }, []>(
      "SELECT DISTINCT thread_id FROM turns WHERE status = 'interrupted'",
    )
    .all()
    .map((r) => r.thread_id);
}

/** The thread was told: its interrupted tasks become plain `cancelled` (no repeat notice next start). */
export function ackInterrupted(db: Database, threadId: string): void {
  db.query(
    "UPDATE turns SET status = 'cancelled' WHERE status = 'interrupted' AND thread_id = ?",
  ).run(threadId);
}

/** Number of cap-counted tasks currently running or waiting for approval (concurrency cap). */
export function countActiveCappedTasks(db: Database): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM turns WHERE counts_toward_cap = 1 AND status IN ('running', 'waiting_approval')",
    )
    .get()!.n;
}
