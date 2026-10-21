import type { Database } from "bun:sqlite";

/** Persisted mapping thread -> Claude session. */
export interface SessionRow {
  thread_id: string;
  session_id: string;
  location: string;
  cwd: string;
  status: string;
  updated_at: number;
  /** Model that owns the session (null = not recorded). Optional on the type: code-built rows omit the v8 fields. */
  model?: string | null;
  /** Compaction cycle of the thread when the session started (see `setSession`). */
  generation?: number;
  /** `role` = a role's thread session; `lead` = a lead session (a lead never resumes a `role` one). */
  kind?: string;
}

/** Get the session saved for a thread, or null. */
export function getSession(db: Database, threadId: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE thread_id = ?").get(threadId);
}

/**
 * Insert or update the session for a thread. A new row takes its `generation` from the thread's summary cycle
 * (the number of SDK compactions so far); an update keeps the stored one. `model` / `kind` left out on an update keep the stored value.
 */
export function setSession(
  db: Database,
  s: {
    threadId: string;
    sessionId: string;
    location: string;
    cwd: string;
    status?: string;
    model?: string;
    kind?: string;
  },
): void {
  db.query(
    `INSERT INTO sessions (thread_id, session_id, location, cwd, status, updated_at, model, kind, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'role'), COALESCE((SELECT cycle FROM thread_summaries WHERE thread_id = ?), 0))
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id,
       location = excluded.location, cwd = excluded.cwd, status = excluded.status,
       updated_at = excluded.updated_at, model = COALESCE(excluded.model, model), kind = COALESCE(?, kind)`,
  ).run(
    s.threadId,
    s.sessionId,
    s.location,
    s.cwd,
    s.status ?? "active",
    Date.now(),
    s.model ?? null,
    s.kind ?? null,
    s.threadId,
    s.kind ?? null, // update branch: a missing kind keeps the stored one
  );
}

/** Forget a thread's session so the next message starts a fresh one. */
export function deleteSession(db: Database, threadId: string): void {
  db.query("DELETE FROM sessions WHERE thread_id = ?").run(threadId);
}
