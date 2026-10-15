import { validateRegistry } from "../roles/capability-registry";
import type { RoleDefinition } from "../roles/role-types";

/**
 * Startup refusal for a bad role registry. Returns the reason, or undefined when every role is valid.
 * `registry` is a parameter only so tests can pass their own roles; boot uses the real one.
 */
export function registryError(
  registry?: Readonly<Record<string, RoleDefinition>>,
): string | undefined {
  try {
    validateRegistry(registry);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
