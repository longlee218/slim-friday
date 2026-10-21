import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";

/**
 * Marker of the one-time memory migrations: `<AGENT_HOME>/data/memory-migrations.json` = `{ "<step>": "<ISO time>" }`.
 * A migration writes its step LAST, so a crash re-runs it (every step is idempotent). Shared by all memory steps.
 */
export const markerFile = (home: string): string =>
  join(workspacePaths(home).home, "data", "memory-migrations.json");

/** Steps done so far. A missing, unreadable or malformed file reads as "none" (re-running an idempotent step is safe). */
export function readMarker(home: string): Record<string, string> {
  const file = markerFile(home);
  if (!existsSync(file)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** True when `step` was marked done. */
export const isMigrated = (home: string, step: string): boolean => step in readMarker(home);

/** Mark `step` done (temp file + rename, 0600; other steps are kept). */
export function markMigrated(home: string, step: string, now: Date = new Date()): void {
  const file = markerFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ ...readMarker(home), [step]: now.toISOString() }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  renameSync(tmp, file);
}
