import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHome } from "../../memory/persona";

/** A throwaway AGENT_HOME holding the default persona and memory files (what a fresh install writes at start). */
export function makeDefaultHome(): string {
  const home = mkdtempSync(join(tmpdir(), "prompt-home-"));
  ensureHome(home, []);
  return home;
}
