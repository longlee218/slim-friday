/** Guard of the git MCP server's tools (path first, then by risk). Pure, like the rest of the guard. */
import { GIT_TOOL } from "../mcp/mcp-tool-names";
import { GIT_GROUPS, GIT_READ_BY_MODE } from "../tools/tool-catalog";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { resolveReal } from "./paths";

/** Attribution lines that must never appear in a commit message (AI co-author / generated-with trailers). */
export const hasAttribution = (text: string): boolean =>
  /co-authored-by|generated (with|by)|🤖|noreply@anthropic\.com/i.test(text);

/** git MCP tools (@cyanheads/git-mcp-server) by risk. Everything else of that server is denied for agents. */
const GIT_READ = new Set<string>(GIT_GROUPS.read);

/** Decide a call of the git MCP server: allowed path only, then by risk. */
export function checkGitMcp(
  name: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  const path = typeof input.path === "string" ? input.path : "";
  let real = "";
  try {
    real = path ? resolveReal(path) : "";
  } catch {
    /* unresolvable: denied below */
  }
  const isWorktree = !!ctx.gitWriteRepo && real === ctx.gitWriteRepo;
  if (!real || !(isWorktree || ctx.gitReadRepos?.includes(real))) {
    return {
      decision: "deny",
      reason: "git tools need an explicit path of the task worktree or a registered repo",
    };
  }
  const mode = typeof input.mode === "string" ? input.mode : undefined;
  const readModes = GIT_READ_BY_MODE[name];
  if (GIT_READ.has(name) || (readModes && (mode === undefined || readModes.includes(mode)))) {
    return { decision: "allow", reason: "git read tool" };
  }
  if (!isWorktree)
    return { decision: "deny", reason: "git changes are only allowed in the task worktree" };
  if (name === GIT_TOOL.ADD) return { decision: "allow", reason: "git tool in worktree" };
  if (name === GIT_TOOL.COMMIT) {
    // Identity comes from the server's env: the agent may not pick an author, amend, or skip hooks.
    if (input.author !== undefined || input.amend || input.noVerify) {
      return {
        decision: "deny",
        reason: "commit as configured: no author override, amend or no-verify",
      };
    }
    if (typeof input.message === "string" && hasAttribution(input.message)) {
      return {
        decision: "deny",
        reason:
          "commit as the owner only: remove Co-Authored-By / generated-with / AI attribution lines",
      };
    }
    return { decision: "allow", reason: "git commit in worktree" };
  }
  if (name === GIT_TOOL.CHECKOUT)
    return { decision: "ask", reason: `${name} changes branch or files` };
  if (name === GIT_TOOL.RESET && mode !== "hard")
    return { decision: "ask", reason: `${name} changes the index/history` };
  return { decision: "deny", reason: `${name} is not available to agents (the app handles it)` };
}

/** A git MCP tool that can only read (a by-mode tool such as branch counts: its write modes are denied by `checkGitMcp`). */
export const isGitReadTool = (name: string): boolean =>
  GIT_READ.has(name) || name in GIT_READ_BY_MODE;
