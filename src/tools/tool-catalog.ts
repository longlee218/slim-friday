import type { Capability, RoleDefinition } from "../roles/role-types";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  LSP_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_MCP_RESOURCE_DIR_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  READ_TOOL_NAME,
  REFRESH_MCP_TOOLS_TOOL_NAME,
  REPORT_FINDINGS_TOOL_NAME,
  SEND_FEEDBACK_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "./sdk-tool-names";

/**
 * The single place that says WHICH tools exist. WHICH role gets what is data in `src/roles` (capabilities);
 * everything here (SDK options, the guard's auto-allowed list) is
 * derived from a role by the functions below. Functions take a RoleDefinition.
 */

/** Built-in tools of each capability. */
export const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  // LSP is inert unless the owner installs a code-intelligence plugin: no app code for that.
  read: [READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, LSP_TOOL_NAME],
  write: [WRITE_TOOL_NAME, EDIT_TOOL_NAME, MULTI_EDIT_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME],
  shell: [BASH_TOOL_NAME],
  web: [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME],
  skills: [SKILL_TOOL_NAME],
  // Agent starts the SDK's built-in subagent; SendMessage resumes one; ListAgents lists the reachable ones (the app
  // defines no subagent types). `toolsFor` adds them to every role without `noSubagents`; roles do not list the capability.
  subagents: [AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, LIST_AGENTS_TOOL_NAME],
  tasks: [
    TODO_WRITE_TOOL_NAME,
    TASK_CREATE_TOOL_NAME,
    TASK_UPDATE_TOOL_NAME,
    TASK_LIST_TOOL_NAME,
    TASK_GET_TOOL_NAME,
    TASK_STOP_TOOL_NAME,
    TOOL_SEARCH_TOOL_NAME,
  ],
  mcp: [
    LIST_MCP_RESOURCES_TOOL_NAME,
    READ_MCP_RESOURCE_TOOL_NAME,
    READ_MCP_RESOURCE_DIR_TOOL_NAME,
    REFRESH_MCP_TOOLS_TOOL_NAME,
    WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  ],
  review: [REPORT_FINDINGS_TOOL_NAME],
  feedback: [SEND_FEEDBACK_TOOL_NAME],
  ask: [ASK_USER_QUESTION_TOOL_NAME],
};

/** Tools that run without asking anyone (the other tools go through path/policy checks or the owner). */
const AUTO_ALLOWED = new Set<string>([
  ...CAPABILITY_TOOLS.web,
  ...CAPABILITY_TOOLS.skills,
  ...CAPABILITY_TOOLS.subagents,
  // TaskStop is NOT auto-allowed: it takes any task/agent id and the guard cannot tell "own" from foreign ones -> owner asks.
  ...CAPABILITY_TOOLS.tasks.filter((t) => t !== TASK_STOP_TOOL_NAME),
  // MCP reads, and a refresh of the app's own (strict-config) servers: no outward or persistent effect.
  ...CAPABILITY_TOOLS.mcp,
]);

/**
 * Built-in tools of a role (the SDK `tools` option): the tools of its capabilities, plus the `subagents` tools that
 * every role gets unless it sets `noSubagents` (today only the developer may spawn: owner). Deduplicated, so a role that still lists the capability is harmless.
 */
export const toolsFor = (role: RoleDefinition): string[] => [
  ...new Set([
    ...role.capabilities.flatMap((c) => CAPABILITY_TOOLS[c]),
    ...(role.noSubagents ? [] : CAPABILITY_TOOLS.subagents),
  ]),
];

/**
 * Capabilities whose tools a SUBAGENT may call (owner allowlist): files, shell, web and skills only. Everything else is
 * denied to a subagent: every MCP tool (report, memory, teammate, effect), AskUserQuestion, Agent/SendMessage/ListAgents,
 * tasks, mcp, feedback and unknown tools. The ONE place of this list.
 */
export const SUBAGENT_CAPABILITIES: readonly Capability[] = [
  "read",
  "write",
  "shell",
  "web",
  "skills",
];

/** Tools a subagent of this role may call: the tools of the role's capabilities that are in `SUBAGENT_CAPABILITIES` (no `shell` in the role = no Bash for its subagents). */
export const subagentToolsFor = (role: RoleDefinition): string[] => [
  ...new Set(
    role.capabilities
      .filter((c) => SUBAGENT_CAPABILITIES.includes(c))
      .flatMap((c) => CAPABILITY_TOOLS[c]),
  ),
];

/** Tools of a role that need no approval (the guard's `allowTools`). */
export const autoAllowedTools = (role: RoleDefinition): string[] =>
  toolsFor(role).filter((t) => AUTO_ALLOWED.has(t));

/* ---------------- SDK options ---------------- */

/**
 * Scoped deny rules for secret files (documented: disallowedTools accepts `Tool(pattern)` rules
 * that are denied in every permission mode). Backstop for the prompt rule; redaction is the other.
 */
export const SECRET_FILE_RULES = [
  `${READ_TOOL_NAME}(**/.env*)`,
  `${READ_TOOL_NAME}(**/*.pem)`,
  `${READ_TOOL_NAME}(**/*.key)`,
  `${READ_TOOL_NAME}(**/id_rsa*)`,
  `${READ_TOOL_NAME}(**/credentials*)`,
];

/**
 * SDK options fragment for a role, derived from this catalog. ONLY `tools` restricts the built-in set
 * (we trust the SDK for that, verified per mode with the real SDK); `allowedTools` would auto-approve and
 * bypass canUseTool, so it is never used. `disallowedTools` only carries what `tools` cannot express: the
 * path-scoped secret-file rules.
 */
export function toolOptions(role: RoleDefinition) {
  return {
    tools: toolsFor(role),
    disallowedTools: [...SECRET_FILE_RULES],
    // Only the MCP servers we pass in `mcpServers`; ignore account connectors and project .mcp.json.
    strictMcpConfig: true,
  };
}
