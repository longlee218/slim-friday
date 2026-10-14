import type { Database } from "bun:sqlite";

/** Persisted mapping thread -> Claude session. */
export interface SessionRow {
  thread_id: string;
  session_id: string;
  location: string;
  cwd: string;
  status: string;
  updated_at: number;
}

/** Get the session saved for a thread, or null. */
export function getSession(db: Database, threadId: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE thread_id = ?").get(threadId);
}

/** Insert or update the session for a thread. */
export function setSession(
  db: Database,
  s: { threadId: string; sessionId: string; location: string; cwd: string; status?: string },
): void {
  db.query(
    `INSERT INTO sessions (thread_id, session_id, location, cwd, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id,
       location = excluded.location, cwd = excluded.cwd, status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(s.threadId, s.sessionId, s.location, s.cwd, s.status ?? "active", Date.now());
}

/** Forget a thread's session so the next message starts a fresh one. */
export function deleteSession(db: Database, threadId: string): void {
  db.query("DELETE FROM sessions WHERE thread_id = ?").run(threadId);
}
