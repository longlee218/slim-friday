import type { Database } from "bun:sqlite";
import type { Effort, TaskClass } from "../config/model-routing";
import { redactText } from "../observability/redact";

/** Lifecycle of a proposal: `pending` -> (`queued`) -> `dispatched` | `refused` | `expired`. */
export type ProposalStatus = "pending" | "queued" | "dispatched" | "refused" | "expired";

/** Statuses a proposal may leave for each target (fail closed: a terminal row never changes). */
const FROM: Record<ProposalStatus, ProposalStatus[]> = {
  pending: [],
  queued: ["pending"],
  dispatched: ["pending", "queued"],
  refused: ["pending", "queued"],
  expired: ["pending", "queued"],
};

/** Proposals still open after this long are `expired` at startup. */
export const PROPOSAL_TTL_MS = 24 * 3_600_000;

/** A proposed hand-over of work to a role (persisted by the orchestrator, never by the proposer). */
export interface Proposal {
  id: string;
  threadId: string;
  workspace: string;
  /** Task whose turn produced it; null for an intent-layer proposal. */
  fromTurnId: string | null;
  role: string;
  brief: string;
  repo: string | null;
  class: TaskClass | null;
  scope: string | null;
  confidence: number | null;
  reason: string | null;
  /** Effort resolved when it was queued (null = the stage defaults); read back when the queue starts it. */
  effort: Effort | null;
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
}

/** What the caller supplies; the rest is generated. */
export type NewProposal = Pick<Proposal, "threadId" | "workspace" | "role" | "brief"> &
  Partial<Omit<Proposal, "id" | "status" | "createdAt" | "decidedAt">>;

const COLS = `id, thread_id AS threadId, workspace, from_turn_id AS fromTurnId, role, brief, repo,
  class, scope, confidence, reason, effort, status, created_at AS createdAt, decided_at AS decidedAt`;

/** Insert a `pending` proposal (brief stored redacted) and return its id. */
export function insertProposal(db: Database, p: NewProposal, now = Date.now()): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO proposals (id, thread_id, workspace, from_turn_id, role, brief, repo, class,
       scope, confidence, reason, effort, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    p.threadId,
    p.workspace,
    p.fromTurnId ?? null,
    p.role,
    redactText(p.brief),
    p.repo ?? null,
    p.class ?? null,
    p.scope ?? null,
    p.confidence ?? null,
    p.reason === undefined || p.reason === null ? null : redactText(p.reason),
    p.effort ?? null,
    now,
  );
  return id;
}

/** One proposal by id, or null. */
export function getProposal(db: Database, id: string): Proposal | null {
  return db.query<Proposal, [string]>(`SELECT ${COLS} FROM proposals WHERE id = ?`).get(id);
}

/** The newest `pending` proposal of a thread (what `go` starts), or null. */
export function pendingProposal(db: Database, threadId: string): Proposal | null {
  return db
    .query<Proposal, [string]>(
      `SELECT ${COLS} FROM proposals WHERE thread_id = ? AND status = 'pending'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId);
}

/** Every `pending` proposal, oldest first (the startup notice walks this). */
export function listPendingProposals(db: Database): Proposal[] {
  return db
    .query<Proposal, []>(
      `SELECT ${COLS} FROM proposals WHERE status = 'pending' ORDER BY created_at, rowid`,
    )
    .all();
}

/**
 * Move a proposal to `status` when the transition is legal. Returns false (row untouched) for an unknown
 * id or an illegal move, e.g. a second dispatch of the same proposal.
 */
export function setProposalStatus(
  db: Database,
  id: string,
  status: Exclude<ProposalStatus, "pending">,
  now = Date.now(),
): boolean {
  const from = FROM[status];
  // `decided_at` marks a final decision; `queued` is still open.
  const decidedAt = status === "queued" ? null : now;
  const marks = from.map(() => "?").join(", ");
  const r = db
    .query(`UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status IN (${marks})`)
    .run(status, decidedAt, id, ...from);
  return r.changes > 0;
}

/** Mark the thread's other `pending` proposals `expired` (a newer ask superseded them); returns how many. */
export function supersedePending(
  db: Database,
  threadId: string,
  keepId: string | undefined,
  now = Date.now(),
): number {
  return db
    .query(
      `UPDATE proposals SET status = 'expired', decided_at = ?
       WHERE thread_id = ? AND status = 'pending' AND id != ?`,
    )
    .run(now, threadId, keepId ?? "").changes;
}

/** Expire open (`pending` / `queued`) proposals older than the TTL; returns how many. */
export function expireOldProposals(db: Database, now = Date.now()): number {
  return db
    .query(
      `UPDATE proposals SET status = 'expired', decided_at = ?
       WHERE status IN ('pending', 'queued') AND created_at < ?`,
    )
    .run(now, now - PROPOSAL_TTL_MS).changes;
}

/** The oldest `queued` proposal of a thread (the owner said yes: it runs when the active task ends), or null. */
export function oldestQueuedProposal(db: Database, threadId: string): Proposal | null {
  return db
    .query<Proposal, [string]>(
      `SELECT ${COLS} FROM proposals WHERE thread_id = ? AND status = 'queued'
       ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(threadId);
}

/** How many `queued` proposals the thread holds. */
export function countQueuedProposals(db: Database, threadId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM proposals WHERE thread_id = ? AND status = 'queued'",
      )
      .get(threadId)?.n ?? 0
  );
}

/**
 * Startup: a `queued` proposal lost the run it waited for (restart). Put it back to `pending` so `go` starts it
 * and nothing launches silently later. Returns the threads that have one.
 */
export function releaseQueued(db: Database): string[] {
  return db
    .query<{ thread_id: string }, []>(
      `UPDATE proposals SET status = 'pending', decided_at = NULL WHERE status = 'queued' RETURNING thread_id`,
    )
    .all()
    .map((r) => r.thread_id);
}

/** Refuse every `queued` proposal of a thread (`stop`: the owner cancelled the work); returns how many. */
export function refuseQueued(db: Database, threadId: string, now = Date.now()): number {
  return db
    .query(
      `UPDATE proposals SET status = 'refused', decided_at = ? WHERE thread_id = ? AND status = 'queued'`,
    )
    .run(now, threadId).changes;
}
