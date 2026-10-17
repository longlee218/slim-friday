import { loadWorkspaces } from "../workspaces/workspace-registry";
import type { BodyRoots } from "./artifact-body";

/**
 * File roots of the running app: AGENT_HOME, and a location looked up in the workspaces' yaml on each repo read (so a
 * location the owner removed stops serving at once).
 */
export function appRoots(home: string): BodyRoots {
  return {
    home,
    locationPath: (workspace, name) =>
      loadWorkspaces(home)
        .workspaces.find((w) => w.name === workspace)
        ?.locations.find((l) => l.name === name)?.path,
  };
}
