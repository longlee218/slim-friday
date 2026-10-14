import type { Database } from "bun:sqlite";

/** Who made the thread: the bot (from a message or slash command) or the owner (adopted on first mention). */
export type ThreadOrigin = "bot" | "adopted";

/** Row of `threads`. `placeholder` is the name the bot gave; `title`/`digest` come from SetThreadTitle. */
export interface ThreadRow {
  thread_id: string;
  channel_id: string;
  workspace: string;
  origin: ThreadOrigin;
  placeholder: string | null;
  title: string | null;
  digest: string | null;
  created_at: number;
  updated_at: number;
}

/** Row of a thread, or null when unknown. */
export function getThread(db: Database, threadId: string): ThreadRow | null {
  return db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE thread_id = ?").get(threadId);
}

/** Record a thread the bot just opened (`origin='bot'`, with its placeholder name). Idempotent per thread id. */
export function recordBotThread(
  db: Database,
  threadId: string,
  channelId: string,
  workspace: string,
  placeholder: string,
  now: number = Date.now(),
): void {
  db.query(
    `INSERT OR IGNORE INTO threads (thread_id, channel_id, workspace, origin, placeholder, created_at, updated_at)
     VALUES (?, ?, ?, 'bot', ?, ?, ?)`,
  ).run(threadId, channelId, workspace, placeholder, now, now);
}

/** Record an owner-made thread as adopted (no placeholder: it is never renamed). Idempotent per thread id. */
export function adoptThread(
  db: Database,
  threadId: string,
  channelId: string,
  workspace: string,
  now: number = Date.now(),
): void {
  db.query(
    `INSERT OR IGNORE INTO threads (thread_id, channel_id, workspace, origin, created_at, updated_at)
     VALUES (?, ?, ?, 'adopted', ?, ?)`,
  ).run(threadId, channelId, workspace, now, now);
}

/** True when the thread was adopted (owner-made, answered without a mention from now on). */
export function isAdopted(db: Database, threadId: string): boolean {
  return (
    db
      .query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM threads WHERE thread_id = ? AND origin = 'adopted'",
      )
      .get(threadId) !== null
  );
}

/**
 * Store the title and digest of a thread (callers redact and clip first). Overwrites both and bumps
 * `updated_at`; creates the row (origin 'bot') when the thread is unknown, with the run's `channelId` and
 * `workspace` ('' when the run did not know them: readers must ignore `channel_id = ''`). An existing row
 * with an empty channel/workspace is backfilled; a filled one is never changed.
 */
export function saveTitle(
  db: Database,
  threadId: string,
  title: string,
  digest: string,
  now: number = Date.now(),
  channelId = "",
  workspace = "",
): void {
  db.query(
    `INSERT INTO threads (thread_id, channel_id, workspace, origin, title, digest, created_at, updated_at)
     VALUES (?, ?, ?, 'bot', ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, digest = excluded.digest, updated_at = excluded.updated_at,
       channel_id = CASE WHEN threads.channel_id = '' THEN excluded.channel_id ELSE threads.channel_id END,
       workspace = CASE WHEN threads.workspace = '' THEN excluded.workspace ELSE threads.workspace END`,
  ).run(threadId, channelId, workspace, title, digest, now, now);
}
