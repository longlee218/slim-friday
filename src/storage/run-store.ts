import type { Database } from "bun:sqlite";
import type { TaskClass } from "../config/model-routing";
import { redactText } from "../observability/redact";
import { interruptRunningStages } from "./stage-store";

/** Final status of a task row. */
export type TaskStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  /** Cut short by a restart/shutdown; the thread gets a Resume offer, then the row becomes cancelled. */
  | "interrupted"
  | "timeout";

/** Change a task's status without ending it (no-op when the row is missing). */
export function setTaskStatus(db: Database, id: string, status: TaskStatus): void {
  db.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

/** Record the Claude session of a task (reported at `system/init`) and the cwd it runs in. */
export function setTaskSession(db: Database, id: string, sessionId: string, cwd: string): void {
  db.query("UPDATE tasks SET session_id = ?, session_cwd = ? WHERE id = ?").run(sessionId, cwd, id);
}

/** Latest task of a thread with the session it recorded (what Resume continues), or null. */
export function latestTaskSession(
  db: Database,
  threadId: string,
): {
  status: string;
  repo: string;
  sessionId: string | null;
  cwd: string | null;
  /** The task's last run ended on its budget (`go +<usd>` may resume it). */
  budgetStopped: boolean;
} | null {
  const row = db
    .query<
      {
        status: string;
        repo: string;
        sessionId: string | null;
        cwd: string | null;
        outcome: string | null;
      },
      [string]
    >(
      `SELECT status, repo, session_id AS sessionId, session_cwd AS cwd,
         (SELECT r.outcome FROM runs r WHERE r.task_id = tasks.id ORDER BY r.rowid DESC LIMIT 1) AS outcome
       FROM tasks WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
  if (!row) return null;
  const { outcome, ...rest } = row;
  return { ...rest, budgetStopped: outcome === "max_budget" };
}

/** Insert a task row in `running` state. */
export function insertTask(
  db: Database,
  t: {
    id: string;
    threadId: string;
    source: string;
    repo: string;
    type: string;
    /** Delegated task text (handoff only); stored redacted so a rejected plan can be recalled. */
    brief?: string;
    /** Task class (owner prefix / proposal); null = standard. */
    cls?: TaskClass;
    /** Proposal this task was started from. */
    proposalId?: string;
    /** Role that runs it (default: dev for code, assistant for Q&A). */
    role?: string;
    /** `staged` = several stages with owner gates (dev); `single` = one run (Q&A). */
    kind?: "staged" | "single";
    /** Task whose turn proposed this one, and how many hand-overs deep it is (0 = owner-started). */
    parentTaskId?: string;
    hop?: number;
  },
): void {
  // Only code tasks count against the concurrency cap (see `countActiveCappedTasks`).
  db.query(
    `INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at, brief, class, proposal_id, counts_toward_cap, role, kind, parent_task_id, hop)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.threadId,
    t.source,
    t.repo,
    t.type,
    Date.now(),
    t.brief === undefined ? null : redactText(t.brief),
    t.cls ?? null,
    t.proposalId ?? null,
    t.type === "code" ? 1 : 0,
    t.role ?? (t.type === "code" ? "dev" : "assistant"),
    t.kind ?? (t.type === "code" ? "staged" : "single"),
    t.parentTaskId ?? null,
    t.hop ?? 0,
  );
}

/** Set final status and end time of a task. */
export function finishTask(db: Database, id: string, status: TaskStatus): void {
  db.query("UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
}

/** Mark every still-`running` task `interrupted` (restart/shutdown) and cancel their pending approvals. */
export function interruptRunningTasks(db: Database): void {
  const now = Date.now();
  db.query(
    "UPDATE tasks SET status = 'interrupted', ended_at = ? WHERE status IN ('running', 'waiting_approval')",
  ).run(now);
  interruptRunningStages(db);
  // Buttons of a dead process can never be answered (a resumed run asks again).
  db.query(
    "UPDATE approvals SET decision = 'cancelled', decided_at = ? WHERE decision = 'pending'",
  ).run(now);
}

/** Threads that have an interrupted task (each needs one Resume notice). */
export function listInterruptedThreads(db: Database): string[] {
  return db
    .query<{ thread_id: string }, []>(
      "SELECT DISTINCT thread_id FROM tasks WHERE status = 'interrupted'",
    )
    .all()
    .map((r) => r.thread_id);
}

/** The thread was told: its interrupted tasks become plain `cancelled` (no repeat notice next start). */
export function ackInterrupted(db: Database, threadId: string): void {
  db.query(
    "UPDATE tasks SET status = 'cancelled' WHERE status = 'interrupted' AND thread_id = ?",
  ).run(threadId);
}

/** Number of cap-counted tasks (code tasks) currently running or waiting for approval (concurrency cap). */
export function countActiveCappedTasks(db: Database): number {
  return db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM tasks WHERE counts_toward_cap = 1 AND status IN ('running', 'waiting_approval')",
    )
    .get()!.n;
}
