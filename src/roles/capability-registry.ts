import { validateForKind } from "../tools/derive-tool-policy";
import { policyOf, toolIdsOf } from "../tools/role-policy";
import { ROLES } from "./role-registry";
import type { RoleDefinition } from "./role-types";

/** True when a run of the role may have partly written files or caused an external side effect: never re-run automatically. */
export const mayHaveWritten = (r: RoleDefinition): boolean =>
  policyOf(r).write || r.sideEffects === "external";

/**
 * Startup check: every registry key equals its role's name, every role has a side-effect class, and every tool id of a
 * role is in the tool catalog and can be built by the role's kind of run. Throws.
 */
export function validateRegistry(registry: Readonly<Record<string, RoleDefinition>> = ROLES): void {
  for (const [key, r] of Object.entries(registry)) {
    if (key !== r.name) throw new Error(`Registry key ${key} != role name ${r.name}`);
    if (!r.sideEffects) throw new Error(`Role ${r.name}: sideEffects is not set`);
    try {
      validateForKind(toolIdsOf(r), r.kind);
    } catch (err) {
      throw new Error(`Role ${r.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
