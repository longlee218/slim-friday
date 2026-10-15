import { DEVELOPER_ROLE } from "./builtin/developer-role";
import { DISCORD_MANAGER_ROLE } from "./builtin/discord-manager-role";
import { LEAD_ROLE } from "./builtin/lead-role";
import { PLANNER_ROLE } from "./builtin/planner-role";
import { SCOUT_ROLE } from "./builtin/scout-role";
import { canonicalRoleName } from "./role-aliases";
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
  r.background && r.sideEffects !== "none";

/** Roles the lead may dispatch as workers (`dispatchable` data flag), whatever their surface. */
export const dispatchableWorkers = (): RoleDefinition[] =>
  Object.values(ROLES).filter((r) => r.dispatchable);

/** True for a role that runs in space channels (the default surface); a `control` role is never routed to from one. */
export const isSpaceRole = (r: RoleDefinition): boolean => (r.surface ?? "space") === "space";

/** Roles of the space surface: the only ones intent routing, dispatch and reroute may offer. */
export const spaceRoles = (): RoleDefinition[] => Object.values(ROLES).filter(isSpaceRole);

/** The role of the control channel (#ops-control), found by its `surface` data; undefined when none is registered. */
export const controlRole = (): RoleDefinition | undefined =>
  Object.values(ROLES).find((r) => r.surface === "control");

/** Role by name (an old stored name reads as its current one); an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[canonicalRoleName(name)];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}

/**
 * Legacy `turns.type` column value of a role's task ("qa" | "code"), derived from role data: a background role is
 * "code". The column stays for old rows (additive schema); nothing reads it back.
 */
export const turnTypeOf = (role: RoleDefinition): "qa" | "code" =>
  role.background ? "code" : "qa";
