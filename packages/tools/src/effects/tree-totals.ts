import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

/* Size of a path tree, walked without following symlinks and with hard caps, so a huge or hostile tree never stalls a call. */

/** Most files and dirs one walk visits. */
const MAX_WALK_FILES = 100_000;
/** Longest one walk may take (ms). */
export const MAX_WALK_MS = 2_000;

/** Totals of a walk; `capped` = it stopped early (file cap, time budget or an unreadable dir): the size is unknown. */
export interface TreeTotals {
  files: number;
  bytes: number;
  capped: boolean;
}

/**
 * Count the entries and bytes under each of `paths` (a symlink counts as itself, never followed). Stops at the file cap,
 * the time budget or once `limitBytes` is passed (the caller only compares); an unreadable dir counts as capped.
 */
export function treeTotals(
  paths: string[],
  limitBytes = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): TreeTotals {
  const t: TreeTotals = { files: 0, bytes: 0, capped: false };
  const deadline = now() + MAX_WALK_MS;
  const stack = [...paths];
  while (stack.length > 0 && !t.capped && t.bytes <= limitBytes) {
    const p = stack.pop() as string;
    if (++t.files > MAX_WALK_FILES || now() > deadline) {
      t.capped = true;
      break;
    }
    try {
      const st = lstatSync(p);
      t.bytes += st.size;
      if (!st.isDirectory()) continue;
      const dir = opendirSync(p);
      try {
        for (let e = dir.readSync(); e; e = dir.readSync()) {
          stack.push(join(p, e.name));
          if (stack.length > MAX_WALK_FILES) {
            t.capped = true;
            break;
          }
        }
      } finally {
        dir.closeSync();
      }
    } catch {
      t.capped = true; // unreadable or vanished: the size is unknown
    }
  }
  return t;
}
