import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { isInside } from "../guardrails/paths";
import type { GitMcp } from "../mcp/git-mcp";
import { GIT_TOOL } from "../mcp/mcp-tool-names";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

/** Minimum gap between refreshes of the same repo. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** repo path -> time of last refresh attempt (in memory; resets on restart). */
const lastRefresh = new Map<string, number>();

/** True only when `path` really is a workspace clone `AGENT_HOME/workspaces/<name>/repo` (symlinks and `..` resolved). */
export function isManagedClone(path: string, agentHome: string): boolean {
  try {
    const root = realpathSync(join(agentHome, "workspaces"));
    const real = realpathSync(path); // strict: a missing path is not a clone
    return isInside(root, real) && /^[^/\\]+[/\\]repo([/\\]|$)/.test(relative(root, real));
  } catch {
    return false; // missing path or workspaces dir
  }
}

/**
 * Fetch + fast-forward (via the git MCP server) so answers use fresh code. Throttled per repo.
 * Fast-forward only: a dirty or diverged clone is left untouched. Failures are non-fatal.
 */
export async function refreshRepo(git: GitMcp, path: string, now = Date.now()): Promise<void> {
  const last = lastRefresh.get(path);
  if (last !== undefined && now - last < REFRESH_INTERVAL_MS) return;
  lastRefresh.set(path, now);
  try {
    await git.call(GIT_TOOL.FETCH, { path, remote: "origin" });
    await git.call(GIT_TOOL.PULL, { path, remote: "origin", fastForwardOnly: true });
  } catch (err) {
    logger
      .child({ module: "refresh-repo" })
      .debug({ path, err: errText(err) }, "refresh skipped or failed");
  }
}
