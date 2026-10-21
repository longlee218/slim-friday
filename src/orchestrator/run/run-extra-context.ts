import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { buildLocationsContext } from "../../locations/location-registry";
import { buildPersonaContext } from "../../memory/persona";
import { buildPromptContext } from "../../memory/prompt-context";
import { threadTitleNote } from "../../roles/prompts/thread-title-note";
import type { RoleDefinition } from "../../roles/role-types";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";

/**
 * The extra prompt context of a role run (after the role's rules and COMMON):
 * - lead: TEAM, AGENTS, IDENTITY, SOUL, USER, memory (root, channel), then the thread-title note;
 * - worker: locations registry, memory (root, channel; read-only), task ledger (no persona: the lead speaks to the owner);
 * - no workspace (the control channel): the root persona files only.
 */
export function runExtraContext(p: {
  db: Database;
  config: AgentConfig;
  i: RoleRunInput;
  s: RoleScope;
  role: RoleDefinition;
  /** The run can rename its thread (the `Orchestrate set_title` tool is registered). */
  hasTitlePort: boolean;
}): string[] {
  const { db, config, i, s, role } = p;
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
    ledger: i.ledger,
  }).concat(threadTitleNote(db, i.threadId, p.hasTitlePort));
}
