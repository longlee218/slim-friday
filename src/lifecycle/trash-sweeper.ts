import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { trashRoot } from "../orchestrator/effects/trash-store";
import { TRASH_TTL_MS } from "../policy/risk-types";

/* The trash of `DeletePaths` keeps an entry 7 days (`<trash>/<goalId>/<epoch ms>-<random>/`); this sweeper removes the older ones.
   Local fs only: no network, no db. */

const log = logger.child({ module: "trash-sweeper" });

/** How often the sweeper runs after the boot sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** Entry dirs are named `<creation time epoch ms>-<random>` (older ones: the time alone): only such a name is ever removed. */
const ENTRY_NAME = /^\d{10,}(-[0-9a-f]{8})?$/;

/** Remove trash entries older than the TTL (and goal dirs left empty). Returns how many entries went. Never throws. */
export function sweepTrash(home: string, now = Date.now()): number {
  const root = trashRoot(home);
  if (!existsSync(root)) return 0;
  let removed = 0;
  try {
    // `withFileTypes` reports a symlink as a link, not a dir: a planted link is skipped, never followed.
    for (const goal of readdirSync(root, { withFileTypes: true })) {
      if (!goal.isDirectory()) continue;
      const goalDir = join(root, goal.name);
      for (const e of readdirSync(goalDir, { withFileTypes: true })) {
        if (
          !e.isDirectory() ||
          !ENTRY_NAME.test(e.name) ||
          now - Number(e.name.split("-")[0]) <= TRASH_TTL_MS
        )
          continue;
        rmSync(join(goalDir, e.name), { recursive: true, force: true });
        removed++;
      }
      try {
        rmdirSync(goalDir); // only succeeds when empty
      } catch {
        // Still holds entries.
      }
    }
  } catch (err) {
    log.warn({ err: errText(err) }, "trash sweep failed");
  }
  if (removed) logEvent(log, "trash.swept", { removed });
  return removed;
}

/** Sweep now (boot) and every 6 hours; the timer never keeps the process alive. Returns the stop function. */
export function startTrashSweeper(home: string): () => void {
  sweepTrash(home);
  const timer = setInterval(() => sweepTrash(home), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
