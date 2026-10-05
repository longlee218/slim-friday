import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { logger } from "../observability/logger";

/** Minimum gap between refreshes of the same repo. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** repo path -> time of last refresh attempt (in memory; resets on restart). */
const lastRefresh = new Map<string, number>();

/** Per-command cap so a stalled fetch cannot hold the thread lock forever. */
const GIT_TIMEOUT_MS = 30_000;

/** True only when `path` really lives under AGENT_HOME/repos (symlinks and `..` resolved). */
export function isManagedClone(path: string, agentHome: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(join(agentHome, "repos")) + sep);
  } catch {
    return false; // missing path or repos dir
  }
}

/** Run git in `cwd`; true on exit code 0. Never throws. */
async function git(cwd: string, args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // never wait for credentials
      timeout: GIT_TIMEOUT_MS,
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * `git fetch` + fast-forward so answers use fresh code. Throttled per repo.
 * Fast-forward only: a dirty or diverged clone is left untouched. Failures are non-fatal.
 */
export async function refreshRepo(path: string, now = Date.now()): Promise<void> {
  const last = lastRefresh.get(path);
  if (last !== undefined && now - last < REFRESH_INTERVAL_MS) return;
  lastRefresh.set(path, now);
  const ok =
    (await git(path, ["fetch", "--quiet"])) &&
    (await git(path, ["merge", "--ff-only", "--quiet", "@{u}"]));
  if (!ok) logger.child({ module: "refresh-repo" }).debug({ path }, "refresh skipped or failed");
}

/** Test helper: forget throttle state. */
export const resetRefreshState = (): void => lastRefresh.clear();
