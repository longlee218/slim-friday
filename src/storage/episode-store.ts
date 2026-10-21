import type { Database } from "bun:sqlite";

/* Queries of the episodic memory layer (`thread_summaries` rows, one per thread): which threads are idle and need an
   episode, the facts an idle episode is written from, and which episodes expired. SQL lives here only. */

/** A thread that went idle with lead work not yet covered by its episode. */
export interface IdleThread {
  threadId: string;
  /** Discord channel id: the thread's parent (`threads` row) or the channel itself in chat mode (no `threads` row). */
  channelId: string;
  /** Existing episode (empty text when there is none). */
  summary: string;
  /** `updated_at` of the existing episode, 0 when none. */
  episodeAt: number;
  /** `started_at` of the newest successful lead turn (a compaction inside that turn is not older than it). */
  lastTurnStartedAt: number;
}

/**
 * Threads whose newest SUCCESSFUL lead turn ended at or before `idleBefore` (epoch ms), with no turn of any role still
 * running or waiting for approval, and a lead turn that ended after the episode's `updated_at` (or no episode yet).
 * Oldest first, at most `limit`. Writing an episode moves `updated_at` past the turn, so a thread is listed once per
 * burst of activity.
 */
export function idleThreads(
  db: Database,
  leadRole: string,
  idleBefore: number,
  limit: number,
): IdleThread[] {
  return db
    .query<
      {
        thread_id: string;
        channel_id: string | null;
        summary: string | null;
        ep: number | null;
        started: number;
      },
      [string, number, number]
    >(
      `SELECT l.thread_id, th.channel_id, s.summary, s.updated_at AS ep, l.started
       FROM (SELECT thread_id, MAX(ended_at) AS ended, MAX(started_at) AS started
             FROM turns WHERE role = ? AND status = 'done' AND ended_at IS NOT NULL GROUP BY thread_id) l
       LEFT JOIN thread_summaries s ON s.thread_id = l.thread_id
       LEFT JOIN threads th ON th.thread_id = l.thread_id
       WHERE l.ended <= ? AND (s.thread_id IS NULL OR l.ended > s.updated_at)
         AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = l.thread_id
                         AND r.status IN ('running', 'waiting_approval'))
       ORDER BY l.ended LIMIT ?`,
    )
    .all(leadRole, idleBefore, limit)
    .map((r) => ({
      threadId: r.thread_id,
      channelId: r.channel_id ?? r.thread_id,
      summary: r.summary ?? "",
      episodeAt: r.ep ?? 0,
      lastTurnStartedAt: r.started,
    }));
}

/**
 * Facts of one thread since `since` (epoch ms), oldest first, from the db only: the title, the owner messages the lead
 * got (`turns.brief` of lead turns) and the items worked (`subject`, status, result excerpt). Text is already
 * redacted at storage. Empty string when there is nothing.
 */
export function threadFacts(
  db: Database,
  threadId: string,
  leadRole: string,
  since: number,
): string {
  const title = db
    .query<{ title: string | null }, [string]>("SELECT title FROM threads WHERE thread_id = ?")
    .get(threadId)?.title;
  const briefs = db
    .query<{ brief: string }, [string, string, number]>(
      `SELECT brief FROM turns WHERE thread_id = ? AND role = ? AND brief IS NOT NULL AND brief <> ''
         AND started_at > ? ORDER BY started_at`,
    )
    .all(threadId, leadRole, since);
  const items = db
    .query<
      { subject: string | null; status: string; result_excerpt: string | null },
      [string, number]
    >(
      `SELECT subject, status, result_excerpt FROM owned_tasks
       WHERE thread_id = ? AND parent_id IS NOT NULL AND last_progress_at > ? ORDER BY created_at`,
    )
    .all(threadId, since);
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (briefs.length) parts.push(`Owner messages:\n${briefs.map((b) => `- ${b.brief}`).join("\n")}`);
  if (items.length)
    parts.push(
      `Work items:\n${items
        .map(
          (i) =>
            `- [${i.status}] ${i.subject ?? "(no subject)"}${i.result_excerpt ? `: ${i.result_excerpt}` : ""}`,
        )
        .join("\n")}`,
    );
  return parts.join("\n\n");
}

/** Thread ids of the episodes last updated before `cutoff` (epoch ms): the expired ones. */
export function expiredEpisodes(db: Database, cutoff: number): string[] {
  return db
    .query<{ thread_id: string }, [number]>(
      "SELECT thread_id FROM thread_summaries WHERE updated_at < ?",
    )
    .all(cutoff)
    .map((r) => r.thread_id);
}

/** An episode dreaming may consume: its text and the `updated_at` version that was read. */
export interface UnpromotedEpisode {
  threadId: string;
  summary: string;
  updatedAt: number;
}

/** Episodes of one channel with text and no dream since their last update (`updated_at > promoted_at`), oldest first. */
export function unpromotedEpisodes(
  db: Database,
  workspace: string,
  channel: string,
): UnpromotedEpisode[] {
  return db
    .query<{ thread_id: string; summary: string; updated_at: number }, [string, string]>(
      `SELECT thread_id, summary, updated_at FROM thread_summaries
       WHERE workspace = ? AND channel = ? AND summary <> '' AND updated_at > promoted_at
       ORDER BY updated_at`,
    )
    .all(workspace, channel)
    .map((r) => ({ threadId: r.thread_id, summary: r.summary, updatedAt: r.updated_at }));
}

/**
 * Mark the read versions of episodes as consumed: `promoted_at` takes the `updated_at` that was read, and only while the
 * row still has it, so an episode rewritten meanwhile stays unpromoted (its newer text was never used).
 */
export function markEpisodesPromoted(db: Database, used: readonly UnpromotedEpisode[]): void {
  const up = db.query(
    "UPDATE thread_summaries SET promoted_at = ? WHERE thread_id = ? AND updated_at = ?",
  );
  for (const e of used) up.run(e.updatedAt, e.threadId, e.updatedAt);
}

/** An episode of one channel as the per-turn related block needs it. */
export interface RelatedEpisode {
  threadId: string;
  /** Thread title, null when the thread has none (or no `threads` row). */
  title: string | null;
  abstract: string;
  /** Full episode text, used only to count how many query terms it shares (never shown). */
  summary: string;
  updatedAt: number;
}

/**
 * Episodes among `threadIds` that belong to workspace + channel (the channel check is repeated here on purpose: the
 * block must never show another channel's episode, whatever the search returned). Rows with no abstract are left out.
 */
export function episodesOfChannel(
  db: Database,
  workspace: string,
  channel: string,
  threadIds: readonly string[],
): RelatedEpisode[] {
  if (threadIds.length === 0) return [];
  const marks = threadIds.map(() => "?").join(", ");
  return db
    .query<
      {
        thread_id: string;
        title: string | null;
        abstract: string;
        summary: string;
        updated_at: number;
      },
      string[]
    >(
      `SELECT s.thread_id, th.title, s.abstract, s.summary, s.updated_at FROM thread_summaries s
       LEFT JOIN threads th ON th.thread_id = s.thread_id
       WHERE s.workspace = ? AND s.channel = ? AND s.abstract <> '' AND s.thread_id IN (${marks})`,
    )
    .all(workspace, channel, ...threadIds)
    .map((r) => ({
      threadId: r.thread_id,
      title: r.title,
      abstract: r.abstract,
      summary: r.summary,
      updatedAt: r.updated_at,
    }));
}
