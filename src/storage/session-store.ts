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
  /** `role` = a role's thread session; `teammate` = a teammate session (a teammate never resumes a `role` one). */
  kind?: string;
  /** Teammate sessions: `<cycle>:<hash>` of the last memory block sent in this session (null = none). */
  memory_mark?: string | null;
  /** Teammate sessions: hash of the config the session started with (null = the default chief-of-staff). */
  config_mark?: string | null;
}

/** Get the session saved for a thread, or null. */
export function getSession(db: Database, threadId: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE thread_id = ?").get(threadId);
}

/**
 * Insert or update the session for a thread. A new row takes its `generation` from the thread's summary cycle
 * (the number of SDK compactions so far); an update keeps the stored one. `model` / `kind` left out on an update keep the stored value.
 * A new session id clears `memory_mark` (the new session has seen no memory block yet) and takes the thread's current
 * compaction cycle as its `generation`. `configMark` is stored as given (undefined = null).
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
    configMark?: string;
  },
): void {
  db.query(
    `INSERT INTO sessions (thread_id, session_id, location, cwd, status, updated_at, model, kind, generation, config_mark)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'role'), COALESCE((SELECT cycle FROM thread_summaries WHERE thread_id = ?), 0), ?)
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id,
       location = excluded.location, cwd = excluded.cwd, status = excluded.status,
       updated_at = excluded.updated_at, model = COALESCE(excluded.model, model), kind = COALESCE(?, kind),
       memory_mark = CASE WHEN excluded.session_id = session_id THEN memory_mark END,
       generation = CASE WHEN excluded.session_id = session_id THEN generation ELSE excluded.generation END,
       config_mark = excluded.config_mark`,
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
    s.configMark ?? null,
    s.kind ?? null, // update branch: a missing kind keeps the stored one
  );
}

/** Record the memory block sent in `sessionId` (no-op when the thread's row holds another session). */
export function setMemoryMark(
  db: Database,
  threadId: string,
  sessionId: string,
  mark: string,
): void {
  db.query("UPDATE sessions SET memory_mark = ? WHERE thread_id = ? AND session_id = ?").run(
    mark,
    threadId,
    sessionId,
  );
}
