import { randomBytes } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { treeTotals } from "../policy/tree-totals";

/* The trash of `DeletePaths`: <AGENT_HOME>/trash/<goalId>/<epoch ms>-<random>/<n>-<name>, kept 7 days (sweeper), emptied by /purge. */

/** Goal ids are uuids: only such an id is turned into a path. */
const GOAL_ID = /^[A-Za-z0-9-]{1,80}$/;

/** Root of the trash. */
export const trashRoot = (home: string): string => join(home, "trash");

/** One moved path: where it was and where it is now. */
interface TrashEntry {
  from: string;
  to: string;
}

/** Result of a move: the entries done (also when it stopped half way) and the error that stopped it. */
export interface TrashMove {
  dir: string;
  entries: TrashEntry[];
  error?: string;
}

/** True when something exists at `p` (a link counts as itself). */
function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Another volume: copy (links stay links, nothing is overwritten), verify the copy matches, only then remove the original. */
function copyVerifyRemove(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const [a, b] = [treeTotals([from]), treeTotals([to])];
  if (a.capped || b.capped || a.files !== b.files || a.bytes !== b.bytes) {
    rmSync(to, { recursive: true, force: true }); // a bad copy never stays; the original is untouched
    throw Object.assign(new Error("copy mismatch"), { code: "COPY_MISMATCH" });
  }
  rmSync(from, { recursive: true });
}

/**
 * Move real paths (already validated by the caller) into a NEW trash entry of the goal (`<epoch ms>-<random>`: two calls
 * never share a dir). `still(from)` runs right before each move: false stops with `CHANGED` (the path was swapped since it
 * was validated). A rename when the volume is the same and the target does not exist; across volumes copy, verify, remove.
 * A manifest file is written next to the entries. Stops at the first failure and reports what was moved so far. Throws
 * only for an invalid goal id.
 */
export function moveToTrash(
  home: string,
  goalId: string,
  paths: string[],
  now: number,
  still: (from: string) => boolean = () => true,
): TrashMove {
  if (!GOAL_ID.test(goalId)) throw new Error("invalid goal id");
  const dir = join(trashRoot(home), goalId, `${now}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries: TrashEntry[] = [];
  for (const [i, from] of paths.entries()) {
    const to = join(dir, `${i}-${basename(from)}`);
    try {
      if (!still(from)) return { dir, entries, error: "CHANGED" };
      if (exists(to)) return { dir, entries, error: "EXISTS" }; // never overwrite
      try {
        renameSync(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        copyVerifyRemove(from, to);
      }
      entries.push({ from, to });
    } catch (err) {
      return { dir, entries, error: (err as NodeJS.ErrnoException).code ?? "move failed" };
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ entries }), { mode: 0o600 });
  return { dir, entries };
}

/** Empty the trash of the given goals now (`/purge`). Returns how many goal dirs existed. */
export function purgeGoalTrash(home: string, goalIds: string[]): number {
  let n = 0;
  for (const id of goalIds.filter((g) => GOAL_ID.test(g))) {
    const dir = join(trashRoot(home), id);
    // rmSync never follows a symlink: a link planted as the goal dir is removed, not its target.
    try {
      rmSync(dir, { recursive: true });
      n++;
    } catch {
      // No trash for this goal.
    }
  }
  return n;
}
