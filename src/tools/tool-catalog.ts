import type { RoleDefinition } from "../roles/role-types";
import { CAPABILITY_TOOLS } from "./capability-tools";
import { policyOf } from "./role-policy";
import { READ_TOOL_NAME } from "./sdk-tool-names";
import { SDK_TOOL_ENTRIES } from "./tool-catalog-sdk-entries";

/**
 * Compatibility surface of the tool catalog (`tool-catalog-entries.ts` says WHAT each tool is, `derive-tool-policy.ts`
 * turns a role's tool ids into its policy). WHICH tools a role gets is data in `src/roles`.
 */

export { CAPABILITY_TOOLS };

/** Ids of the tool groups a SUBAGENT may call (owner allowlist): files, shell, web and skills; everything else is denied to a subagent. */
export const SUBAGENT_CAPABILITIES: readonly string[] = SDK_TOOL_ENTRIES.filter(
  (d) => d.subagentUsable,
).map((d) => d.id);

/** Built-in tools of a role (the SDK `tools` option): its groups' tools plus the subagent tools unless it opts out. */
export const toolsFor = (role: RoleDefinition): string[] => policyOf(role).sdkTools;

/** Tools a subagent of this role may call (no `shell` in the role = no Bash for its subagents). */
export const subagentToolsFor = (role: RoleDefinition): string[] => policyOf(role).subagentTools;

/** Tools of a role that need no approval (the guard's `allowTools`). */
export const autoAllowedTools = (role: RoleDefinition): string[] => policyOf(role).autoAllow;

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
