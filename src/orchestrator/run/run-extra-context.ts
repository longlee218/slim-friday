import type { AgentConfig } from "../../config/agent-config";
import { buildLocationsContext } from "../../locations/location-registry";
import { buildLocationRulesContext } from "../../locations/location-rules";
import { buildPersonaContext } from "../../memory/persona";
import { buildPromptContext } from "../../memory/prompt-context";
import type { RoleDefinition } from "../../roles/role-types";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";

/**
 * The extra prompt context of a role run (after the role's rules and COMMON):
 * - lead: `<owner_files>` (AGENTS, IDENTITY, SOUL, USER), `<team>`; memory and the thread-title note go in its user turn
 *   (orchestrator/lead/lead-user-turn.ts), so the system prompt does not change between turns;
 * - worker: locations registry, location rules of its locations, memory (root, channel; read-only), task ledger (no persona: the lead speaks to the owner);
 * - no workspace (the control channel): the root persona files only.
 */
export function runExtraContext(p: {
  config: AgentConfig;
  i: RoleRunInput;
  s: RoleScope;
  role: RoleDefinition;
}): string[] {
  const { config, i, s, role } = p;
  if (i.workspace === undefined)
    return [buildPersonaContext(config.agentHome).text].filter(Boolean);
  const worker = role.kind === "worker";
  return buildPromptContext({
    agentHome: config.agentHome,
    workspace: i.workspace,
    channel: i.channel,
    kind: worker ? "worker" : "lead",
    team: i.team,
    registry: worker ? buildLocationsContext(i.workspace, s.scope, true) : "",
    locationRules: worker ? buildLocationRulesContext(s.scope) : "",
    ledger: i.ledger,
  });
}
