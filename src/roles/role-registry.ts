import { DEVELOPER_ROLE } from "./builtin/developer-role";
import { DISCORD_MANAGER_ROLE } from "./builtin/discord-manager-role";
import { LEAD_ROLE } from "./builtin/lead-role";
import { PLANNER_ROLE } from "./builtin/planner-role";
import { SCOUT_ROLE } from "./builtin/scout-role";
import type { RoleDefinition } from "./role-types";

/** Every role of the app, by name. A new role = one file in `builtin/` + one line here. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  [DEVELOPER_ROLE.name]: DEVELOPER_ROLE,
  [DISCORD_MANAGER_ROLE.name]: DISCORD_MANAGER_ROLE,
  [LEAD_ROLE.name]: LEAD_ROLE,
  [PLANNER_ROLE.name]: PLANNER_ROLE,
  [SCOUT_ROLE.name]: SCOUT_ROLE,
};

/** A task of this role counts toward the concurrent task cap: it runs in the background AND may change something (a read-only scout does not). */
export const countsTowardCap = (r: RoleDefinition): boolean =>
  r.kind === "worker" && r.sideEffects !== "none";

/** Roles the lead may dispatch as workers (`dispatchable` data flag), whatever their kind. */
export const dispatchableWorkers = (): RoleDefinition[] =>
  Object.values(ROLES).filter((r) => r.dispatchable);

/** The role of the control channel (#ops-control), found by its `kind` data; undefined when none is registered. */
export const controlRole = (): RoleDefinition | undefined =>
  Object.values(ROLES).find((r) => r.kind === "control");

/** Role by name, or undefined when none is registered. */
export const findRole = (name: string): RoleDefinition | undefined => ROLES[name];

/** Role by name; an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}
