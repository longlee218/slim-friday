/**
 * Guard rules for calls made INSIDE a subagent (hook input has `agent_id`) and for starting one. Generic: no
 * subagent name appears here, the scope comes from data (`GuardrailContext.subagentScopes`, built from the
 * stage's subagent list and the registry). Pure, like the rest of the guard.
 *
 * Why it exists: a subagent has no owner path, and under `bypassPermissions` the hook is the only gate, so a
 * guard `ask` would silently RUN. Every ask of a subagent call therefore becomes a deny.
 */
import { GIT_MCP_SERVER, mcpServerPrefix } from "../mcp/mcp-tool-names";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isGitReadTool } from "./git-mcp-guard";

/** Who made the call: present only inside a subagent (the main agent has no `agent_id`). */
export interface AgentCaller {
  id: string;
  /** Subagent type; missing = unknown (denied). */
  type?: string;
}

/** Hint every subagent denial ends with, so the model reports instead of retrying. */
const STOP_HINT = "stop and report NEEDS_CONTEXT";

const deny = (reason: string): Decision => ({ decision: "deny", reason });

const isSpawnTool = (name: string): boolean =>
  name === AGENT_TOOL_NAME || name === LEGACY_AGENT_TOOL_NAME;

/** File writes and shell: what a read-only subagent never gets. */
const WRITE_OR_SHELL = new Set<string>([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  BASH_TOOL_NAME,
  MONITOR_TOOL_NAME,
]);

/**
 * Input keys of an Agent call that are accepted. Observed: exactly `description, prompt, subagent_type,
 * run_in_background` (fixture pre-tool-use-parent-agent-call.json); that is only what the spike passed, the SDK
 * schema may have more (unverified). Anything else (`model`, `mode`, `isolation`...) is denied.
 */
const SPAWN_KEYS = new Set(["description", "prompt", "subagent_type", "run_in_background"]);

/**
 * Agent/Task call from the MAIN agent: the type must be one of the stage's subagents, the input only carries
 * known keys (a per-call mode/isolation/model key would be unreviewed under bypass), and never in background
 * (a background subagent outlives its turn and is not watched).
 */
export function checkSpawn(input: Record<string, unknown>, ctx: GuardrailContext): Decision {
  const type = input.subagent_type;
  if (typeof type !== "string" || !ctx.allowedSubagents?.includes(type))
    return deny("only the configured subagents may be started");
  const extra = Object.keys(input).filter((k) => !SPAWN_KEYS.has(k));
  if (extra.length)
    return deny(
      `Agent input key not allowed: ${extra.join(", ")} (use only ${[...SPAWN_KEYS].join(", ")})`,
    );
  if (input.run_in_background !== undefined && input.run_in_background !== false)
    return deny("background subagents are not allowed: run it in the foreground");
  return { decision: "allow", reason: "configured subagent" };
}

/** Rules that apply before the normal checks to a call with `agent_id`; undefined = go on to the normal checks. */
function preflight(toolName: string, ctx: GuardrailContext): Decision | undefined {
  const agent = ctx.agent as AgentCaller;
  // No owner path from a subagent: a question or a plan approval would reach (and burn) the owner's one round.
  if (toolName === ASK_USER_QUESTION_TOOL_NAME || toolName === EXIT_PLAN_MODE_TOOL_NAME)
    return deny(`not allowed in a subagent: ${STOP_HINT}`);
  // Depth 1: a subagent never starts another one.
  if (isSpawnTool(toolName)) return deny("a subagent may not start subagents");
  // Unknown or missing type (not listed by the stage) = no scope = fail closed.
  const scope = agent.type ? ctx.subagentScopes?.[agent.type] : undefined;
  if (!scope) return deny(`unknown subagent type "${agent.type ?? ""}"`);
  // Its own tool list again (the SDK `tools` option is the first lock): no Skill, WebFetch, Task tools...
  if (!scope.tools.includes(toolName)) return deny(`${toolName} is not a tool of this subagent`);
  if (scope.readOnly && WRITE_OR_SHELL.has(toolName))
    return deny(`read-only subagent: ${toolName} is not allowed`);
  if (
    !scope.canCommit &&
    toolName.startsWith(mcpServerPrefix(GIT_MCP_SERVER)) &&
    !isGitReadTool(toolName.slice(mcpServerPrefix(GIT_MCP_SERVER).length))
  )
    return deny("this subagent may only read git state");
  return undefined;
}

/**
 * Decision for a call with `agent_id`: the preflight rules, then `base` (the main-agent checks), where every
 * `ask` becomes a deny. `base` is passed in to keep this file free of an import cycle with check-tool-call.
 */
export function checkSubagentCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
  base: (t: string, i: Record<string, unknown>, c: GuardrailContext) => Decision,
): Decision {
  const pre = preflight(toolName, ctx);
  if (pre) return pre;
  const d = base(toolName, input, ctx);
  return d.decision === "ask" ? deny(`not allowed in a subagent (${d.reason}): ${STOP_HINT}`) : d;
}
