import { ASSISTANT_ROLE } from "./builtin/assistant-role";
import { DEV_ROLE } from "./builtin/dev-role";
import type { RoleDefinition, StageDefinition } from "./role-types";

/** Every role of the app, by name. A new role = one file in `builtin/` + one line here. */
export const ROLES: Readonly<Record<string, RoleDefinition>> = {
  [ASSISTANT_ROLE.name]: ASSISTANT_ROLE,
  [DEV_ROLE.name]: DEV_ROLE,
};

/** Stage names the app runs today (log `mode` values). */
export type StageName = "qa" | "plan" | "exec";

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

/** Roles a Q&A run may hand work to (`DelegateTask` enum): every role with a `whenToUse`, except the assistant. */
export function delegableRoleNames(): [string, ...string[]] {
  const names = Object.values(ROLES)
    .filter((r) => r.whenToUse && r.name !== ASSISTANT_ROLE.name)
    .map((r) => r.name);
  return names as [string, ...string[]];
}

/** Name + `whenToUse` of every role: the input of the intent layer (P1.4c). */
export function intentRoles(): { name: string; whenToUse: string }[] {
  return Object.values(ROLES).map(({ name, whenToUse }) => ({ name, whenToUse }));
}
