import { ASSISTANT_ROLE } from "./builtin/assistant-role";
import { DEV_ROLE } from "./builtin/dev-role";
import type { RoleDefinition, StageDefinition } from "./role-types";

/** Every role of the app, by name. A new role = one file in `builtin/` + one line here. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  [ASSISTANT_ROLE.name]: ASSISTANT_ROLE,
  [DEV_ROLE.name]: DEV_ROLE,
};

/** Stage name (the log `mode` value): any name a role's stage defines. */
export type StageName = string;

/** A stage, or its name (tests and logs speak names; callers pass definitions). */
export type StageRef = StageDefinition | StageName;

/** Role by name; an unknown name is a programming/config error. */
export function getRole(name: string): RoleDefinition {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role: ${name}`);
  return role;
}

/** Stage `stage` of role `role`. */
export function getStage(role: string, stage: StageName): StageDefinition {
  const found = getRole(role).stages.find((s) => s.name === stage);
  if (!found) throw new Error(`Role ${role} has no stage ${stage}`);
  return found;
}

/** Resolve a StageRef: definitions pass through; names are unique across roles. */
export function stageOf(ref: StageRef): StageDefinition {
  if (typeof ref !== "string") return ref;
  return findStage(Object.values(ROLES), ref);
}

/** Role that owns `stage` (identity match), or undefined for an ad-hoc stage that is in no role. */
export function roleOfStage(stage: StageDefinition): RoleDefinition | undefined {
  return Object.values(ROLES).find((r) => r.stages.includes(stage));
}

/** Unique stage `name` across `roles`; unknown or ambiguous (in several roles) throws. */
export function findStage(roles: readonly RoleDefinition[], name: string): StageDefinition {
  const found = roles.flatMap((r) => r.stages).filter((s) => s.name === name);
  if (found.length === 0) throw new Error(`Unknown stage: ${name}`);
  if (found.length > 1) {
    throw new Error(
      `Ambiguous stage "${name}": defined in more than one role, pass the definition`,
    );
  }
  return found[0];
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
 * Legacy `tasks.type` column value of a role's task ("qa" | "code"), derived from role data: a role counted
 * toward the task cap is "code". The column stays for old rows (additive schema); nothing reads it back.
 */
export const turnTypeOf = (role: RoleDefinition): "qa" | "code" =>
  role.countsTowardCap ? "code" : "qa";

/** `tasks.kind` of a role's task: several stages = `staged`, one run = `single`. */
export const turnKindOf = (role: RoleDefinition): "staged" | "single" =>
  role.stages.length > 1 ? "staged" : "single";

/** The role a plain message starts (`entry` flag); replaced by the intent layer's pick (P1.4c). */
export function entryRole(): RoleDefinition {
  const role = Object.values(ROLES).find((r) => r.entry);
  if (!role) throw new Error("No role has the entry flag");
  return role;
}

/** The role whose follow-up messages continue in an existing clone (`followUp` data). */
export function followUpRole(): RoleDefinition {
  const role = Object.values(ROLES).find((r) => r.followUp);
  if (!role) throw new Error("No role has followUp data");
  return role;
}

/** The intent `class` picks a model tier for this role: some stage has `classTiers` (data, no flag). */
export const hasClassTiers = (role: RoleDefinition): boolean =>
  role.stages.some((s) => s.classTiers !== undefined);

/** A role with an owner gate after some stage: it needs the Discord approval flow. */
export const isGated = (role: RoleDefinition): boolean =>
  role.stages.some((s) => (s.gate ?? "none") !== "none");

/** Some stage of the role works in an isolated clone: only then a follow-up "fix round" in that clone makes sense. */
export const usesClone = (role: RoleDefinition): boolean =>
  role.stages.some((s) => s.isolation === "clone");
