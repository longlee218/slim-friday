import { isSpaceRole, ROLES } from "./role-registry";
import type { Capability, RoleDefinition } from "./role-types";

/** Who can take a request (pure helpers over role data; no role names here, authorization stays in the guards). */
export interface RerouteQuery {
  /** Roles already tried for this request. */
  visited: string[];
  /** The Discord approval flow is available (roles with `approvalRequired` need it). */
  hasApprovals: boolean;
  /** Only roles that have all of these capabilities (a check names one when it needs it). */
  requires?: Capability[];
  /** Router probability per role name; higher first, unknown names (e.g. `unclear`) are ignored. */
  ranking?: Record<string, number>;
}

const allRoles = (): RoleDefinition[] => Object.values(ROLES);
/** Roles a request may be handed to: the space surface only. */
const spaceOnly = (): RoleDefinition[] => allRoles().filter(isSpaceRole);

/**
 * Roles a failed or refused request may be handed to: dispatchable (has `whenToUse`), authorized, capable, not
 * visited. Ordered by `ranking` (desc) when given; ties and unranked roles keep registry order.
 */
export function rerouteCandidates(
  q: RerouteQuery,
  roles: RoleDefinition[] = spaceOnly(),
): string[] {
  const eligible = roles.filter(
    (r) =>
      r.whenToUse &&
      !q.visited.includes(r.name) &&
      (!r.approvalRequired || q.hasApprovals) &&
      (q.requires ?? []).every((c) => r.capabilities.includes(c)),
  );
  const score = (r: RoleDefinition): number => q.ranking?.[r.name] ?? -1;
  // Array.sort is stable: equal scores keep registry order.
  const ordered = q.ranking ? [...eligible].sort((a, b) => score(b) - score(a)) : eligible;
  return ordered.map((r) => r.name);
}

/** True when a run of the role may have partly written files or caused an external side effect: never re-run automatically. */
export const mayHaveWritten = (r: RoleDefinition): boolean =>
  r.capabilities.includes("write") || r.sideEffects === "external";

/** `name@capabilityVersion` of every role, joined: lets a logged decision be tied to the data it ran on. */
export function registryVersion(roles: RoleDefinition[] = allRoles()): string {
  return roles.map((r) => `${r.name}@${r.capabilityVersion}`).join(",");
}

/**
 * Startup check: every registry key equals its role's name, every role has a side-effect class, and a background
 * role requires approvals (its plan / delivery goes through the owner); a control-surface role has no tag. Throws.
 */
export function validateRegistry(registry: Readonly<Record<string, RoleDefinition>> = ROLES): void {
  for (const [key, r] of Object.entries(registry)) {
    if (key !== r.name) throw new Error(`Registry key ${key} != role name ${r.name}`);
    if (!r.sideEffects) throw new Error(`Role ${r.name}: sideEffects is not set`);
    if (r.surface === "control" && r.tag)
      throw new Error(
        `Role ${r.name}: a control role cannot have a tag (no space message routes to it)`,
      );
    if (r.background && !r.approvalRequired)
      throw new Error(`Role ${r.name}: a background role must set approvalRequired`);
  }
}
