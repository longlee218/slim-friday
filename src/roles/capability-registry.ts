import { ROLES } from "./role-registry";
import type { RoleDefinition } from "./role-types";

/** True when a run of the role may have partly written files or caused an external side effect: never re-run automatically. */
export const mayHaveWritten = (r: RoleDefinition): boolean =>
  r.capabilities.includes("write") || r.sideEffects === "external";

/**
 * Startup check: every registry key equals its role's name and every role has a side-effect class. Throws.
 */
export function validateRegistry(registry: Readonly<Record<string, RoleDefinition>> = ROLES): void {
  for (const [key, r] of Object.entries(registry)) {
    if (key !== r.name) throw new Error(`Registry key ${key} != role name ${r.name}`);
    if (!r.sideEffects) throw new Error(`Role ${r.name}: sideEffects is not set`);
  }
}
