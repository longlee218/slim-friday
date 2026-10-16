import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { SENSITIVE_PATHS } from "../config/sensitive-paths";

/** Deepest dir level searched under a granted dir (a `$HOME` grant is wide: the search stays bounded). */
const MAX_DEPTH = 5;
/** Most entries visited per granted dir; beyond it the search stops (the rest of the tree is not covered). */
const MAX_ENTRIES = 20_000;

const FILE_GLOBS = SENSITIVE_PATHS.files.map((g) => new Bun.Glob(g.toLowerCase()));
const DIRS = new Set(SENSITIVE_PATHS.dirs.map((d) => d.toLowerCase()));
const SKIP = new Set(SENSITIVE_PATHS.skip.map((d) => d.toLowerCase()));

/**
 * Sensitive files and dirs (see `data/sensitive-paths.yaml`) inside `root`: a matching file, or a matching dir as a whole.
 * Skipped dirs (node_modules, .git...) are not entered. Bounded by depth and entry count.
 */
export function findSensitive(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    let kids: Dirent[];
    try {
      kids = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const k of kids) {
      if (++seen > MAX_ENTRIES) return;
      const name = k.name.toLowerCase();
      const p = join(dir, k.name);
      if (k.isDirectory()) {
        if (DIRS.has(name)) found.push(p);
        else if (!SKIP.has(name) && depth < MAX_DEPTH) walk(p, depth + 1);
      } else if (FILE_GLOBS.some((g) => g.match(name))) found.push(p);
    }
  };
  walk(root, 0);
  return found;
}
