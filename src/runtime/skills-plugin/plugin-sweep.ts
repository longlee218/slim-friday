import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "../../observability/logger";
import { log } from "./plugin-copy";

/** Stale plugin dirs (left by a crash) older than this are swept at startup. */
const STALE_PLUGIN_MS = 60 * 60 * 1000;
/** Prefix of every plugin dir the app creates under `<home>/tmp` (one per set and one for the workspace dir). */
export const PLUGIN_PREFIX = "plugin-";

/**
 * Startup sweep: remove `<home>/tmp/plugin-*` dirs older than an hour (a crash skipped their cleanup). Covers every
 * plugin kind (sets and workspace dir). Only that prefix, only direct children of `<home>/tmp`, only real
 * directories (symlinks are never followed).
 */
export function sweepStalePlugins(agentHome: string, now = Date.now()): number {
  const base = join(agentHome, "tmp");
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return 0; // no tmp dir yet
  }
  for (const name of names) {
    if (!name.startsWith(PLUGIN_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < STALE_PLUGIN_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn({ dir, err: String(err) }, "stale plugin dir not removed");
    }
  }
  if (removed) logEvent(log, "skills.plugins_swept", { removed });
  return removed;
}
