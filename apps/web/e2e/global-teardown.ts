import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Removes the engine's temp AGENT_HOME (named in the run file) and the run file; never anything outside our prefix. */
export default function globalTeardown(): void {
  const runFile = join(tmpdir(), "friday-e2e-home.txt");
  try {
    const home = readFileSync(runFile, "utf8").trim();
    if (dirname(home) === tmpdir() && basename(home).startsWith("friday-e2e-"))
      rmSync(home, { recursive: true, force: true });
  } catch {
    // no run file: nothing to remove
  }
  rmSync(runFile, { force: true });
}
