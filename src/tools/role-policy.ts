import type { RoleDefinition } from "../roles/role-types";
import { derivePolicy, type ToolPolicy } from "./derive-tool-policy";

/** The tool ids of a role: its SDK groups (`capabilities`) and its MCP tool names. Phase 02 replaces this with the preset's tool list. */
export const toolIdsOf = (role: RoleDefinition): string[] => [
  ...role.capabilities,
  ...(role.mcpTools ?? []),
];

const cache = new WeakMap<RoleDefinition, ToolPolicy>();

/** The policy of a role's runs, derived once from its tool ids. An unknown id or one its run kind cannot build throws. */
export function policyOf(role: RoleDefinition): ToolPolicy {
  let p = cache.get(role);
  if (!p) {
    p = derivePolicy(toolIdsOf(role), { runKind: role.kind, subagents: !role.noSubagents });
    cache.set(role, p);
  }
  return p;
}
