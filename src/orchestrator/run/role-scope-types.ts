import type { Location } from "../../locations/location-registry";
import type { GuardScope } from "../../policy/check-tool-call";

/* Leaf type of role-scope.ts and control-scope.ts (neither imports the other). */

/** What `roleScope` decides for one run. */
export interface RoleScope {
  /** Working dir of the run (real path for a writing role). */
  cwd: string;
  /** Extra dirs the agent may use: the other locations, the thread's attachment copy, the scratch dir of a writing role. */
  additionalDirectories: string[];
  /** Locations the run is about: the pinned one, else every location it sees. */
  scope: Location[];
  /** Claude session to resume, when there is one for this cwd. */
  sessionId?: string;
  /** Path rules of the guard. */
  guard: GuardScope;
}
