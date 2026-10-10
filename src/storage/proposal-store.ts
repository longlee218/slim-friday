import type { Database } from "bun:sqlite";
import type { TaskClass } from "../config/model-routing";
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
  fromTaskId: string | null;
  role: string;
  brief: string;
  repo: string | null;
  base: string | null;
  class: TaskClass | null;
  scope: string | null;
  confidence: number | null;
  reason: string | null;
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
}

/** What the caller supplies; the rest is generated. */
export type NewProposal = Pick<Proposal, "threadId" | "workspace" | "role" | "brief"> &
  Partial<Omit<Proposal, "id" | "status" | "createdAt" | "decidedAt">>;

const COLS = `id, thread_id AS threadId, workspace, from_task_id AS fromTaskId, role, brief, repo, base,
  class, scope, confidence, reason, status, created_at AS createdAt, decided_at AS decidedAt`;

/** Insert a `pending` proposal (brief stored redacted) and return its id. */
export function insertProposal(db: Database, p: NewProposal, now = Date.now()): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO proposals (id, thread_id, workspace, from_task_id, role, brief, repo, base, class,
       scope, confidence, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    p.threadId,
    p.workspace,
    p.fromTaskId ?? null,
    p.role,
    redactText(p.brief),
    p.repo ?? null,
    p.base ?? null,
    p.class ?? null,
    p.scope ?? null,
    p.confidence ?? null,
    p.reason === undefined || p.reason === null ? null : redactText(p.reason),
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
