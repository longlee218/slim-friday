import { afterAll } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { tempDirs } from "./helpers";

/** Remove one dir tree; a test may have left it read-only, so retry once after reopening the top dir. Never throws. */
function removeBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Still locked: leave it, a leaked temp dir must not fail the run.
    }
  }
}

/** Bun preload: after every test file, remove the temp homes and locations `makeEnv` made so runs do not leak into $TMPDIR. */
afterAll(() => {
  for (const d of tempDirs.splice(0)) removeBestEffort(d);
});
