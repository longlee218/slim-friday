import { type Dirent, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errText } from "@friday/tools";
import { homePaths } from "../config/home-paths";
import { logEvent, logger } from "../observability/logger";

/* Keeps AGENT_HOME from growing forever: old app logs and downloaded attachments (`inbox/<conversation>/<epoch>/`) go.
   Local fs only. Symlinks are never followed (`withFileTypes` reports a link as a link) and only names of the app's
   own shape are touched. */

const log = logger.child({ module: "home-retention" });

/** How often the sweeper runs after the boot sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
/** Rolled app logs are kept this long. */
const APP_LOG_RETENTION_DAYS = 14;
/** Downloaded attachments are kept this long (the run that needs one reads it at once). */
const INBOX_RETENTION_DAYS = 1;

/** Rolled app log file name (`app.<yyyy-MM-dd>.<n>.jsonl`). */
const APP_LOG = /^app\.\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/;

/** Entries of `dir`, or none when it is missing or unreadable. */
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Last write of a dir: the newest mtime of the dir and its direct children. */
function lastWrite(dir: string): number {
  let newest = lstatSync(dir).mtimeMs;
  for (const e of entries(dir)) newest = Math.max(newest, lstatSync(join(dir, e.name)).mtimeMs);
  return newest;
}

/** Remove `path` (a file or dir) when its last write is older than `maxAge`; returns 1 when removed. */
function removeIfOld(path: string, isDir: boolean, maxAge: number, now: number): number {
  try {
    const at = isDir ? lastWrite(path) : lstatSync(path).mtimeMs;
    if (now - at <= maxAge) return 0;
    rmSync(path, { recursive: true, force: true });
    return 1;
  } catch (err) {
    log.warn({ path, err: errText(err) }, "retention: not removed");
    return 0;
  }
}

/** Remove `dir` when it is empty (a dir that still holds files stays). */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // Missing or not empty.
  }
}

/** Sweep once; logs `home.swept` with the counts when anything went. Never throws. */
export function sweepHome(home: string, now = Date.now()): Record<string, number> {
  const counts = { appLogs: 0, inbox: 0 };
  try {
    const paths = homePaths(home);
    for (const e of entries(paths.logs)) {
      if (!APP_LOG.test(e.name) || !e.isFile()) continue;
      const path = join(paths.logs, e.name);
      // An empty rolled file (a restart rolled the day's log) goes after a day; the live file is never empty that long.
      const age = lstatSync(path).size === 0 ? DAY_MS : APP_LOG_RETENTION_DAYS * DAY_MS;
      counts.appLogs += removeIfOld(path, false, age, now);
    }
    for (const conv of entries(paths.inbox)) {
      if (!conv.isDirectory()) continue;
      const convDir = join(paths.inbox, conv.name);
      for (const batch of entries(convDir))
        if (batch.isDirectory())
          counts.inbox += removeIfOld(
            join(convDir, batch.name),
            true,
            INBOX_RETENTION_DAYS * DAY_MS,
            now,
          );
      removeIfEmpty(convDir);
    }
    if (Object.values(counts).some((n) => n > 0)) logEvent(log, "home.swept", counts);
  } catch (err) {
    log.warn({ err: errText(err) }, "home retention sweep failed");
  }
  return counts;
}

/** Sweep now (boot) and every 6 hours; the timer never keeps the process alive. Returns the stop function. */
export function startHomeRetention(home: string): () => void {
  sweepHome(home);
  const timer = setInterval(() => sweepHome(home), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Done scratchpad items are kept this long. */
const SCRATCHPAD_DONE_KEEP_DAYS = 30;

/** Delete `done` scratchpad items last updated more than 30 days before `now`; returns the count. */
export function sweepScratchpad(
  store: { deleteDoneBefore(at: number): Promise<number> },
  now = Date.now(),
): Promise<number> {
  return store.deleteDoneBefore(now - SCRATCHPAD_DONE_KEEP_DAYS * DAY_MS);
}
