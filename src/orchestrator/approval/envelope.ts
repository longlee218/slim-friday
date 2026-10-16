import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";
import type { Envelope as PlanEnvelope, Risk } from "../plan/plan-types";
import { DEFAULT_BOUNDS, type EffectTool } from "./risk-types";

/* The envelope of one goal's worker runs: what the owner allowed, checked on every tool call (fail closed). Built from the
   dispatch (DIRECT / DELEGATE) or from the approved plan (PLAN). Pure data + builders. */

/** Branch or target that matches any value (a plan grants a tool on the location, not on one branch). */
export const ANY = "*";

/** One scoped permission to use an effect tool. */
export interface EffectGrant {
  tool: EffectTool;
  scope: {
    /** Location name. */
    location: string;
    /** GitPush / CreatePullRequest: the branch (`*` = any non-default branch). */
    branch?: string;
    /** MergeBranch: the branch merged into (`*` = any). Absent = no merge. */
    into?: string;
    /** Scope not known yet (paths found by an earlier item): held to the bounds instead of asked now. */
    deferred?: boolean;
  };
}

/** Limits of a goal's deferred destructive scope. */
interface Bounds {
  maxItems: number;
  maxBytes: number;
}

/** What a worker run of one goal may do. */
export interface DispatchEnvelope {
  goalId: string;
  /** Location names the goal works in. */
  locations: string[];
  /** The run's own scratch dir (real path): deletes there are inside the envelope too. */
  goalDir: string;
  /** Risk classes the shell may use (R0 + R1 always; R2 only when granted: it opens unknown commands). */
  classes: Risk[];
  effects: EffectGrant[];
  bounds: Bounds;
  /** Audit value of `effect_log.granted_by`: `envelope`, `owner` or `plan:<id>@v<n>`. */
  grantedBy: string;
}

/** Envelope of a goal nobody granted anything: R0 + R1, DeletePaths to the trash within the default bounds. */
export const defaultEnvelope = (
  goalId: string,
  locations: string[],
  goalDir: string,
): DispatchEnvelope => ({
  goalId,
  locations,
  goalDir,
  classes: ["R0", "R1"],
  effects: [],
  bounds: { ...DEFAULT_BOUNDS },
  grantedBy: "envelope",
});

/** The default envelope plus the grants the owner confirmed at dispatch. */
export const envelopeWithGrants = (
  base: DispatchEnvelope,
  grants: EffectGrant[],
): DispatchEnvelope => ({
  ...base,
  effects: grants,
  grantedBy: grants.length ? "owner" : base.grantedBy,
});

/**
 * Envelope of an approved plan: its risk classes, locations and bounds, and the effect tools its risk classes and delivery
 * mode imply (R3 or `pr` = push + PR; `merge` = merge into any branch) on every location of the plan.
 */
export function envelopeFromPlan(
  base: DispatchEnvelope,
  plan: PlanEnvelope,
  ref: { planId: string; version: number },
): DispatchEnvelope {
  const external = plan.riskClasses.includes("R3") || plan.deliveryMode === "pr";
  const tools: EffectTool[] = [
    ...(external ? [GIT_PUSH_TOOL, CREATE_PULL_REQUEST_TOOL] : []),
    ...(plan.deliveryMode === "merge" ? [MERGE_BRANCH_TOOL] : []),
  ] as EffectTool[];
  return {
    ...base,
    locations: plan.locations,
    classes: [...new Set<Risk>(["R0", "R1", ...plan.riskClasses])],
    effects: plan.locations.flatMap((location) =>
      tools.map((tool) => ({
        tool,
        scope: { location, ...(tool === MERGE_BRANCH_TOOL ? { into: ANY } : { branch: ANY }) },
      })),
    ),
    // `maxItems` of a plan counts its steps, not deleted paths: the item bound stays the default; a plan's GB limit applies (0 = unset).
    bounds: {
      maxItems: DEFAULT_BOUNDS.maxItems,
      maxBytes: plan.bounds.maxGb > 0 ? plan.bounds.maxGb * 1024 ** 3 : DEFAULT_BOUNDS.maxBytes,
    },
    grantedBy: `plan:${ref.planId}@v${ref.version}`,
  };
}
