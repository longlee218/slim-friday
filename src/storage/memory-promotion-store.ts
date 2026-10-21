import type { Database } from "bun:sqlite";

/* Ledger of journal bullets that dreaming consumed (`memory_promotions`). Journal files are never rewritten, so this is
   the only record that a bullet was used. SQL lives here only. */

/** Hashes already consumed in one channel. */
export function promotedHashes(db: Database, workspace: string, channel: string): Set<string> {
  return new Set(
    db
      .query<{ hash: string }, [string, string]>(
        "SELECT hash FROM memory_promotions WHERE workspace = ? AND channel = ?",
      )
      .all(workspace, channel)
      .map((r) => r.hash),
  );
}

/** Record bullet hashes as consumed at `now` (a hash already there keeps its first time). */
export function markPromoted(
  db: Database,
  workspace: string,
  channel: string,
  hashes: Iterable<string>,
  now: number,
): void {
  const ins = db.query(
    "INSERT OR IGNORE INTO memory_promotions (workspace, channel, hash, promoted_at) VALUES (?, ?, ?, ?)",
  );
  for (const h of hashes) ins.run(workspace, channel, h, now);
}

/** Delete ledger rows consumed before `cutoff` (epoch ms); returns how many. */
export function prunePromotions(db: Database, cutoff: number): number {
  return db.query("DELETE FROM memory_promotions WHERE promoted_at < ?").run(cutoff).changes;
}
