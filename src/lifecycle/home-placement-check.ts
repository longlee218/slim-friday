import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInside } from "../guardrails/paths";

/** Name of the marker that makes a directory a git working tree root. */
const GIT_MARKER = ".git";

/** Real path of `p`, or `p` itself when it does not exist yet. */
function realOrRaw(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Startup refusal for a badly placed AGENT_HOME. Returns the reason, or undefined when the placement is fine.
 * The home must sit OUTSIDE every registered repo and outside any git working tree (itself or an ancestor
 * holds a git marker): files under a repo checkout could be committed, swept by repo-wide tools, or reached
 * through the repo's read scope. Filesystem check only, no git calls.
 */
export function homePlacementError(agentHome: string, repoPaths: string[]): string | undefined {
  const home = realOrRaw(agentHome);
  if (repoPaths.some((r) => isInside(realOrRaw(r), home))) {
    return "AGENT_HOME is inside a registered repo";
  }
  for (let dir = home; ; dir = dirname(dir)) {
    if (existsSync(join(dir, GIT_MARKER))) return "AGENT_HOME is inside a git working tree";
    if (dirname(dir) === dir) return undefined;
  }
}
