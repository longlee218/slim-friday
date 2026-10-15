import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Temp dirs of a test file: created under $TMPDIR, all removed by `afterAll(cleanupTmp)` (no leftovers after a run). */

/** Real paths of the dirs made and not yet removed. */
const made: string[] = [];

/** A new empty temp dir (real path) that `cleanupTmp` removes. */
export function tmpRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** Remove every dir `tmpRoot` made so far. Call it from `afterAll`. */
export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
