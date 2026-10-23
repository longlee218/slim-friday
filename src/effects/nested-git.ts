import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { foldName } from "../policy/protected-names";

/* Does a delete target CONTAIN a git dir (a nested repo, a submodule, a worktree)? Its history would go to the trash with it and
   `/purge` makes that final, so the owner is asked. The walk is bounded; a walk that stops early answers "unknown" = yes. */

/** Most entries one scan visits, and the deepest level. */
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 12;

/** Folded name of a git dir. */
const GIT = `${String.fromCharCode(46)}git`;

/**
 * True when a dir under `real` (not `real` itself) is, or may be, a git dir: one is found, the tree is too big or too deep to
 * scan, or a dir cannot be read. A plain file or a tree without one is false. Symlinks are never followed.
 */
export function containsNestedGit(real: string): boolean {
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return true;
    let d: ReturnType<typeof opendirSync>;
    try {
      d = opendirSync(dir);
    } catch {
      return true; // unreadable: unknown
    }
    try {
      for (let e = d.readSync(); e; e = d.readSync()) {
        if (++seen > MAX_ENTRIES || foldName(e.name) === GIT) return true;
        if (e.isDirectory() && walk(join(dir, e.name), depth + 1)) return true;
      }
    } finally {
      d.closeSync();
    }
    return false;
  };
  try {
    if (!lstatSync(real).isDirectory()) return false; // a file or a link holds no repo
  } catch {
    return true; // cannot look: unknown
  }
  return walk(real, 0);
}
