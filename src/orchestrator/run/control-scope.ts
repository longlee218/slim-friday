import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../config/agent-config";
import { workspacePaths } from "../../config/workspace-paths";
import { realOrSame } from "../../policy/paths";
import type { RoleRunInput } from "./role-run-types";
import type { RoleScope } from "./role-scope-types";

/** What the control role may read of one space: its config, its persona files and its channels dir (channel memory included) (never tasks, cwd, locations). */
function spaceGrants(home: string, name: string): string[] {
  const w = workspacePaths(home).workspace(name);
  return [w.config, w.user, w.identity, w.agents, w.soul, w.channels];
}

/** Names of the space folders that exist now (a space created during the run is readable from the next run). */
function spaceNames(workspacesDir: string): string[] {
  try {
    return readdirSync(workspacesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Scope of a run that belongs to no workspace (the control-channel role): cwd is `<AGENT_HOME>/tmp/control` (an empty
 * scratch dir), no write path at all, reads limited to that dir and, per space, `workspace.yaml`, the persona/memory
 * files and `channels/` (never `tasks/`, `cwd/`, `locations/`). AGENT_HOME stays denied
 * (secrets, `data/agent.db`, `.env` are never readable); only these grants are made back inside it. The thread's
 * stored Claude session is resumed when it was started in the same cwd.
 */
export function controlScope(config: AgentConfig, i: RoleRunInput): RoleScope {
  const paths = workspacePaths(config.agentHome);
  const cwd = join(config.agentHome, "tmp", "control");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(paths.workspaces, { recursive: true, mode: 0o700 });
  const granted = [
    cwd,
    ...spaceNames(paths.workspaces).flatMap((n) => spaceGrants(config.agentHome, n)),
  ].map(realOrSame);
  return {
    cwd: realOrSame(cwd),
    additionalDirectories: [realOrSame(paths.workspaces)],
    scope: [],
    sessionId: i.existing?.cwd === realOrSame(cwd) ? i.existing.session_id : undefined,
    guard: {
      cwd: realOrSame(cwd),
      readPaths: granted,
      denyPaths: [realOrSame(config.agentHome)],
      allowInside: granted,
    },
  };
}
