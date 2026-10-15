import { ASSISTANT_ROLE } from "./builtin/assistant-role";
import { DEV_ROLE } from "./builtin/dev-role";
import { DISCORD_MANAGER_ROLE } from "./builtin/discord-manager-role";
import { LEAD_ROLE } from "./builtin/lead-role";
import { SCOUT_ROLE } from "./builtin/scout-role";
import type { RoleDefinition } from "./role-types";

/** Every role of the app, by name. A new role = one file in `builtin/` + one line here. The lead is listed AFTER the assistant: `entryRole()` returns the first role with the `entry` flag. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  [ASSISTANT_ROLE.name]: ASSISTANT_ROLE,
  [DEV_ROLE.name]: DEV_ROLE,
  [DISCORD_MANAGER_ROLE.name]: DISCORD_MANAGER_ROLE,
  [LEAD_ROLE.name]: LEAD_ROLE,
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

/** Role by name; an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}

/** Roles the dispatcher may start from a request (a queued follow-up of any role included): every role with a `whenToUse`. */
export function dispatchableRoleNames(): [string, ...string[]] {
  const names = spaceRoles()
    .filter((r) => r.whenToUse)
    .map((r) => r.name);
  return names as [string, ...string[]];
}

/** Name + `whenToUse` of every role: the input of the intent layer (P1.4c). */
export function intentRoles(): { name: string; whenToUse: string }[] {
  return spaceRoles().map(({ name, whenToUse }) => ({ name, whenToUse }));
}

/**
 * Legacy `turns.type` column value of a role's task ("qa" | "code"), derived from role data: a background role is
 * "code". The column stays for old rows (additive schema); nothing reads it back.
 */
export const turnTypeOf = (role: RoleDefinition): "qa" | "code" =>
  role.background ? "code" : "qa";

/** The role a plain message starts (`entry` flag); replaced by the intent layer's pick (P1.4c). */
export function entryRole(): RoleDefinition {
  const role = Object.values(ROLES).find((r) => r.entry);
  if (!role) throw new Error("No role has the entry flag");
  return role;
}

/** The intent `class` picks a model tier for this role: it has `classTiers` (data, no flag). */
export const hasClassTiers = (role: RoleDefinition): boolean => role.classTiers !== undefined;
