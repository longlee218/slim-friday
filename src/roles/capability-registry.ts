import { ROLES } from "./role-registry";
import type { RoleDefinition } from "./role-types";

/** True when a run of the role may have partly written files or caused an external side effect: never re-run automatically. */
export const mayHaveWritten = (r: RoleDefinition): boolean =>
  r.capabilities.includes("write") || r.sideEffects === "external";

/**
 * Startup check: every registry key equals its role's name, every role has a side-effect class, and a background
 * role that changes something requires approvals (its plan / delivery goes through the owner); a control-surface role has no tag. Throws.
 */
export function validateRegistry(registry: Readonly<Record<string, RoleDefinition>> = ROLES): void {
  for (const [key, r] of Object.entries(registry)) {
    if (key !== r.name) throw new Error(`Registry key ${key} != role name ${r.name}`);
    if (!r.sideEffects) throw new Error(`Role ${r.name}: sideEffects is not set`);
    if (r.surface === "control" && r.tag)
      throw new Error(
        `Role ${r.name}: a control role cannot have a tag (no space message routes to it)`,
      );
    if (r.background && r.sideEffects !== "none" && !r.approvalRequired)
      throw new Error(`Role ${r.name}: a background role must set approvalRequired`);
  }
}
