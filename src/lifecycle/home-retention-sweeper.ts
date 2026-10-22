import { type Dirent, existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  APP_LOG_RETENTION_DAYS,
  DB_RETENTION_DAYS,
  RUN_DIR_RETENTION_DAYS,
} from "../config/resilience-caps";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";

/* Keeps AGENT_HOME from growing forever: old task logs, app logs and run dirs go, and the dirs older builds left behind
   (planner-era `goals/`, empty `worktrees/`, the old per-workspace `tasks/`) are removed. Local fs only, no db. Symlinks
   are never followed (`withFileTypes` reports a link as a link) and only names of the app's own shape are touched. */

const log = logger.child({ module: "home-retention" });

/** How often the sweeper runs after the boot sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

/** Rolled app log file name (`app.<yyyy-MM-dd>.<n>.jsonl`). */
const APP_LOG = /^app\.\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/;
/** Per-task log file name (`<task id>.jsonl`). */
const TASK_LOG = /^[A-Za-z0-9_-]+\.jsonl$/;
/** A run dir name (a turn id). */
const RUN_DIR = /^[A-Za-z0-9_-]+$/;

/** Entries of `dir`, or none when it is missing or unreadable. */
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Last write of a dir: the newest mtime of the dir and its direct children (a run writes inside its scratch). */
function lastWrite(dir: string): number {
  let newest = lstatSync(dir).mtimeMs;
  for (const e of entries(dir)) newest = Math.max(newest, lstatSync(join(dir, e.name)).mtimeMs);
  return newest;
}

/** Remove direct children of `dir` matching `name` and `kind` whose last write is older than `cutoff`; returns the count. */
function sweepChildren(
  dir: string,
  name: RegExp,
  kind: "file" | "dir",
  cutoff: (path: string) => number,
  now: number,
): number {
  let removed = 0;
  for (const e of entries(dir)) {
    if (!name.test(e.name) || (kind === "file" ? !e.isFile() : !e.isDirectory())) continue;
    const path = join(dir, e.name);
    try {
      const at = kind === "file" ? lstatSync(path).mtimeMs : lastWrite(path);
      if (now - at <= cutoff(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn({ path, err: errText(err) }, "retention: not removed");
    }
  }
  return removed;
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
  const counts: Record<string, number> = {};
  try {
    const paths = workspacePaths(home);
    const logs = join(home, "logs");
    counts.taskLogs = sweepChildren(
      join(logs, "tasks"),
      TASK_LOG,
      "file",
      () => DB_RETENTION_DAYS * DAY_MS,
      now,
    );
    // An empty rolled file (a restart rolled the day's log) goes after a day; the live file is never empty that long.
    counts.appLogs = sweepChildren(
      logs,
      APP_LOG,
      "file",
      (p) => (lstatSync(p).size === 0 ? DAY_MS : APP_LOG_RETENTION_DAYS * DAY_MS),
      now,
    );
    const runAge = () => RUN_DIR_RETENTION_DAYS * DAY_MS;
    counts.runDirs = sweepChildren(paths.runs, RUN_DIR, "dir", runAge, now);
    // Older builds: run dirs under `workspaces/<ws>/tasks/`, empty `worktrees/` dirs, the planner-era `goals/`.
    for (const ws of entries(paths.workspaces)) {
      if (!ws.isDirectory()) continue;
      const root = join(paths.workspaces, ws.name);
      counts.runDirs += sweepChildren(join(root, "tasks"), RUN_DIR, "dir", runAge, now);
      removeIfEmpty(join(root, "tasks"));
      removeIfEmpty(join(root, "worktrees"));
      for (const loc of entries(join(root, "locations")))
        if (loc.isDirectory()) removeIfEmpty(join(root, "locations", loc.name, "worktrees"));
    }
    const goals = join(home, "goals");
    if (existsSync(goals) && lstatSync(goals).isDirectory()) {
      rmSync(goals, { recursive: true, force: true });
      counts.legacyGoals = 1;
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
