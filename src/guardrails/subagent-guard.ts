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
  SEND_MESSAGE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isSecretPath } from "./deny-dangerous";
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

/** The file-writing tools (Bash writes are judged by the Bash policy). */
const FILE_WRITES = new Set<string>([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);

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
 * Input keys of an Agent call that are accepted (the SDK `AgentInput` has more: effort, mode, isolation, team_name,
 * which stay denied: a per-call mode or isolation key would be unreviewed under bypass). `model` and `name` are
 * checked below.
 */
const SPAWN_KEYS = new Set([
  ...["description", "prompt", "subagent_type", "model", "name", "run_in_background"],
]);

/** A spawn `name`: a slug (the SendMessage target; it is echoed in logs and prompts, so keep it plain and short). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

const clip = (v: unknown): string => String(v).slice(0, 40);

/** Denial of a `subagent_type` outside the stage list: names the valid types and which template maps to which. */
function wrongTypeReason(type: unknown, ctx: GuardrailContext): string {
  const valid = ctx.allowedSubagents ?? [];
  const uses = valid.flatMap((n) => {
    const use = ctx.subagentScopes?.[n]?.use;
    return use ? [`use subagent_type: ${n} for the ${use}`] : [];
  });
  return [
    `subagent_type "${clip(type)}" is not available in this run. Valid types: ${valid.join(", ") || "none"}.`,
    ...(uses.length ? [`${uses.join("; ")}.`] : []),
  ].join(" ");
}

/**
 * Agent/Task call from the MAIN agent (stateless rules; run caps and the unique name are the guard hook's, see
 * `subagent-run.ts`): the type is one of the stage's subagents, the input only has known keys, `model` is a tier
 * inside the stage cap (`ctx.subagentTiers`, none = no explicit model), `name` is a slug, and never in background
 * (a background subagent outlives its turn and is not watched).
 */
export function checkSpawn(input: Record<string, unknown>, ctx: GuardrailContext): Decision {
  const type = input.subagent_type;
  if (typeof type !== "string" || !ctx.allowedSubagents?.includes(type))
    return deny(wrongTypeReason(type, ctx));
  const extra = Object.keys(input).filter((k) => !SPAWN_KEYS.has(k));
  if (extra.length)
    return deny(
      `Agent input key not allowed: ${extra.join(", ")} (use only ${[...SPAWN_KEYS].join(", ")})`,
    );
  const { model, name } = input;
  if (
    model !== undefined &&
    !(typeof model === "string" && ctx.subagentTiers?.includes(model as never))
  )
    return deny(
      `model "${clip(model)}" is above this run's cap: use ${ctx.subagentTiers?.join(", ") || "no explicit model"}`,
    );
  if (name !== undefined && !(typeof name === "string" && NAME_RE.test(name)))
    return deny("name must be a short slug: letters, digits, - and _ (max 40)");
  if (input.run_in_background !== undefined && input.run_in_background !== false)
    return deny("background subagents are not allowed: run it in the foreground");
  return { decision: "allow", reason: "configured subagent" };
}

/** SendMessage input keys seen in the recorded Q19 PreToolUse (fixtures q19-hook-inputs.json); any other key is denied. */
const MESSAGE_KEYS = new Set([
  "to",
  "message",
  "summary",
  "type",
  "recipient",
  "recipient_kind",
  "content",
]);

/**
 * SendMessage from the MAIN agent (stateless rules): only in a stage that has a resumable subagent, `to` a plain
 * string, `message` a string (no structured protocol messages), `type` absent or "message". WHICH target is allowed
 * (a name or agentId spawned in this run) is decided by the guard hook, which owns the run state.
 */
export function checkMessage(input: Record<string, unknown>, ctx: GuardrailContext): Decision {
  if (!Object.values(ctx.subagentScopes ?? {}).some((s) => s.resumable))
    return deny("no subagent of this stage can be resumed");
  const extra = Object.keys(input).filter((k) => !MESSAGE_KEYS.has(k));
  if (extra.length) return deny(`SendMessage input key not allowed: ${extra.join(", ")}`);
  const { to, message, type } = input;
  if (typeof to !== "string" || to === "" || to.length > 80)
    return deny("SendMessage needs `to`: the name or agentId of a subagent you started");
  if (typeof message !== "string") return deny("SendMessage `message` must be a text");
  if (type !== undefined && type !== "message") return deny("only plain messages are allowed");
  return { decision: "allow", reason: "resume of a subagent (target checked per run)" };
}

/** Rules that apply before the normal checks to a call with `agent_id`; undefined = go on to the normal checks. */
function preflight(toolName: string, ctx: GuardrailContext): Decision | undefined {
  const agent = ctx.agent as AgentCaller;
  // No owner path from a subagent: a question or a plan approval would reach (and burn) the owner's one round.
  if (toolName === ASK_USER_QUESTION_TOOL_NAME || toolName === EXIT_PLAN_MODE_TOOL_NAME)
    return deny(`not allowed in a subagent: ${STOP_HINT}`);
  // Depth 1: a subagent never starts another one.
  if (isSpawnTool(toolName)) return deny("a subagent may not start subagents");
  // Resuming is the controller's job: a subagent never messages (another) one (R13 extended).
  if (toolName === SEND_MESSAGE_TOOL_NAME) return deny("a subagent may not message subagents");
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
  // No file named like a secret (.env*, keys, credentials) is written by a subagent, wherever it is.
  const target = input.file_path ?? input.notebook_path;
  if (FILE_WRITES.has(toolName) && typeof target === "string" && isSecretPath(target))
    return deny(`writing secret files is not allowed in a subagent: ${STOP_HINT}`);
  // A subagent writes only in the task clone (the git write repo): not in the plan/scratch dirs the main agent may
  // use. No clone known = no write path at all (fail closed). Bash redirects and `cd` use the same list.
  const writePaths = ctx.gitWriteRepo
    ? (ctx.writePaths ?? []).filter((p) => p === ctx.gitWriteRepo)
    : [];
  const d = base(toolName, input, { ...ctx, writePaths });
  return d.decision === "ask" ? deny(`not allowed in a subagent (${d.reason}): ${STOP_HINT}`) : d;
}
