import type { Database } from "bun:sqlite";
import { EPISODE_TTL_DAYS } from "../config/memory-caps";
import { logEvent, logger } from "../observability/logger";
import { expiredEpisodes } from "../storage/episode-store";
import { deleteThreadSummary, summaryPath } from "../storage/thread-summary-store";
import { pruneJournals } from "./daily-journal";
import { purgePath } from "./index/memory-index";
import { syncAll } from "./index/memory-sync";
import { safely } from "./index/safely";

const log = logger.child({ module: "memory-prune" });

/** Delete the episodes not updated for `EPISODE_TTL_DAYS`, each with its index rows (one transaction per episode). */
function pruneEpisodes(db: Database, now: number): number {
  const ids = expiredEpisodes(db, now - EPISODE_TTL_DAYS * 86_400_000);
  for (const id of ids)
    db.transaction(() => {
      purgePath(db, summaryPath(id));
      deleteThreadSummary(db, id);
    })();
  return ids.length;
}

/**
 * The one prune job: expired episodes (90 d, with their index rows) and old journal day files (30 d, the index is
 * re-synced when files went so their rows go too). Runs at start and every `PRUNE_INTERVAL_MS` from the memory tick.
 * Logs `memory.prune {episodes, journals}`. Never throws (a failing half does not stop the other).
 */
export function pruneMemory(
  db: Database,
  home: string,
  now: Date = new Date(),
): { episodes: number; journals: number } {
  const episodes = safely("prune episodes", () => pruneEpisodes(db, now.getTime())) ?? 0;
  const journals = safely("prune journals", () => pruneJournals(home, now)) ?? 0;
  if (journals > 0) safely("prune sync", () => syncAll(db, home));
  logEvent(log, "memory.prune", { episodes, journals });
  return { episodes, journals };
}
