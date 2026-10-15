import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import type { Route } from "../../config/model-routing";
import { buildLocationsContext } from "../../locations/location-registry";
import { buildPersonaContext } from "../../memory/persona";
import { buildPromptContext } from "../../memory/prompt-context";
import type { RoleDefinition } from "../../roles/role-types";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope";
import { threadTitleNote } from "./thread-title-note";

/**
 * The extra prompt context of a role run: persona, locations registry, memory and task ledger of its workspace, then
 * the router's internal hint and the thread-title note. A run with no workspace (the control channel) gets the root
 * persona files only: no memory layers, no locations, no ledger.
 */
export function runExtraContext(p: {
  db: Database;
  config: AgentConfig;
  i: RoleRunInput;
  s: RoleScope;
  role: RoleDefinition;
  route?: Route;
  /** The run can rename its thread (the `SetThreadTitle` tool is registered). */
  hasTitlePort: boolean;
}): string[] {
  const { db, config, i, s, role, route } = p;
  const hint = route?.internalHint
    ? [`Internal note (not from the owner):\n${route.internalHint}`]
    : [];
  if (i.workspace === undefined)
    return [buildPersonaContext(config.agentHome).text, ...hint].filter(Boolean);
  return buildPromptContext({
    agentHome: config.agentHome,
    workspace: i.workspace,
    channel: i.channel,
    // A background role always sees its location(s) with their test command; a pinned foreground role needs no list.
    registry:
      i.pinned && !role.background
        ? ""
        : buildLocationsContext(i.workspace, s.scope, role.background),
    memoryLocations: s.scope.map((r) => r.name),
    ledger: i.ledger,
  }).concat(hint, threadTitleNote(db, i.threadId, p.hasTitlePort), i.extraSystem ?? []);
}
