import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the main process's lock lives under the agent home. */
export const mainLockPath = (agentHome: string): string => join(agentHome, "data", "main.lock");

/** True when a process with this pid exists (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid written in the lock file; undefined when it is unreadable or not a number. */
function holder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One main process per agent home: `<AGENT_HOME>/data/main.lock` holds the pid of the main that owns the home.
 * It is created atomically with its content (the pid goes into a temp file in the same dir, then `link` puts it
 * in place, which fails when a lock exists), so a lock file is never seen empty or half written by
 * construction. A lock whose pid is no longer alive (a crash), or that holds no pid (an older or damaged file),
 * is taken over; a live holder makes this throw, naming its pid. Returns the release function (removes the
 * file while it still holds this pid). A reused pid of a dead main counts as alive (the owner removes the file
 * by hand).
 */
export function acquireMainLock(agentHome: string, pid = process.pid): () => void {
  const path = mainLockPath(agentHome);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, String(pid), { mode: 0o600 });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        linkSync(temp, path);
        return () => {
          if (holder(path) === pid) unlinkSync(path);
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const other = holder(path);
        if (other !== undefined && other !== pid && alive(other))
          throw new Error(`Another Friday main process (pid ${other}) holds ${path}`);
        // Stale (or our own leftover): remove it and try once more.
        unlinkSync(path);
      }
    }
    throw new Error(`Could not take ${path}`);
  } finally {
    unlinkSync(temp);
  }
}
