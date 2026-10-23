import { join } from "node:path";
import { loadPresets } from "../presets/preset-loader";
import type { RoleDefinition } from "./role-types";

/** Folder of the role files (`config/presets/<role>/{preset.yaml,prompt.md}`), shipped with the repo. */
const PRESETS_DIR = join(import.meta.dir, "..", "..", "config", "presets");

/** Every role of the app, by name, loaded from the preset files at start (a bad file refuses the start). A new role = a new folder. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = loadPresets(PRESETS_DIR);

/** A task of this role counts toward the concurrent task cap: it runs in the background AND may change something (a read-only scout does not). */
export const countsTowardCap = (r: RoleDefinition): boolean =>
  r.kind === "worker" && r.sideEffects !== "none";

/** Roles the teammate may dispatch as workers (`dispatchable` data flag), whatever their kind. */
export const dispatchableWorkers = (): RoleDefinition[] =>
  Object.values(ROLES).filter((r) => r.dispatchable);

/** Role by name, or undefined when none is registered. */
export const findRole = (name: string): RoleDefinition | undefined => ROLES[name];

/** Role by name; an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}
