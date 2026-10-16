import type { Database } from "bun:sqlite";
import { DELETE_PATHS_TOOL } from "../../mcp/effects/tools/DeletePathsTool/constants";
import { effectsOfGoal } from "../../storage/effect-log-store";
import type { BoundsUsage } from "./check-envelope";
import { treeTotals } from "./tree-totals";

/* Size of a delete request and what a goal already moved to the trash. No writes. */

/**
 * Items (one per listed path) and bytes of a delete request. `limitBytes` bounds the walk. A walk that hit its caps (too
 * many files, too slow, unreadable) reports MORE than the limit: unknown size is over the bound (the caller asks), never a stall.
 */
export function measurePaths(paths: string[], limitBytes: number): BoundsUsage {
  const t = treeTotals(paths, limitBytes);
  return { items: paths.length, bytes: t.capped ? limitBytes + 1 : t.bytes };
}

/** Items and bytes the goal's earlier `DeletePaths` calls moved (read from the audit rows; a row that cannot be read counts as nothing). */
export function goalUsage(db: Database, goalId: string): BoundsUsage {
  const total = { items: 0, bytes: 0 };
  for (const e of effectsOfGoal(db, goalId).filter((r) => r.tool === DELETE_PATHS_TOOL)) {
    try {
      const r = JSON.parse(e.result) as { items?: number; bytes?: number };
      total.items += r.items ?? 0;
      total.bytes += r.bytes ?? 0;
    } catch {
      // A foreign result text: not a delete summary.
    }
  }
  return total;
}
