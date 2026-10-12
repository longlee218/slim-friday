import { ASSISTANT_ROLE } from "./builtin/assistant-role";
import { DEV_ROLE } from "./builtin/dev-role";
import type { RoleDefinition } from "./role-types";

/** Every role of the app, by name. A new role = one file in `builtin/` + one line here. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  [ASSISTANT_ROLE.name]: ASSISTANT_ROLE,
  [DEV_ROLE.name]: DEV_ROLE,
};

/** Role by name; an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}

/** Roles the dispatcher may start from a request (a queued follow-up of any role included): every role with a `whenToUse`. */
export function dispatchableRoleNames(): [string, ...string[]] {
  const names = Object.values(ROLES)
    .filter((r) => r.whenToUse)
    .map((r) => r.name);
  return names as [string, ...string[]];
}

/** Name + `whenToUse` of every role: the input of the intent layer (P1.4c). */
export function intentRoles(): { name: string; whenToUse: string }[] {
  return Object.values(ROLES).map(({ name, whenToUse }) => ({ name, whenToUse }));
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
