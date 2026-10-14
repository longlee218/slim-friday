/** Guard of the git MCP server's tools: READ scope only (the assistant). No role that writes gets this server. */
import { GIT_GROUPS, GIT_READ_BY_MODE } from "../tools/tool-catalog";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { resolveReal } from "./paths";
import { containsDenied } from "./protected-paths";

/** Read tools of the git server; every other tool of it is denied. */
const GIT_READ = new Set<string>(GIT_GROUPS.read);

/** Decide a call of the git MCP server: a registered location as `path`, and a read tool (or a read-only `mode`). */
export function checkGitMcp(
  name: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  let real = "";
  try {
    real = typeof input.path === "string" && input.path ? resolveReal(input.path) : "";
  } catch {
    /* unresolvable: denied below */
  }
  if (!real || !ctx.gitReadPaths?.includes(real))
    return { decision: "deny", reason: "git tools need an explicit path of a registered location" };
  // A repo above the agent home (a $HOME location) would expose it through log / diff / show.
  if (containsDenied(real, ctx))
    return { decision: "deny", reason: "this repo path would cover a protected dir" };
  const mode = typeof input.mode === "string" ? input.mode : undefined;
  const readModes = GIT_READ_BY_MODE[name];
  return GIT_READ.has(name) || (readModes && (mode === undefined || readModes.includes(mode)))
    ? { decision: "allow", reason: "git read tool" }
    : { decision: "deny", reason: `${name} is not available here (read only)` };
}
