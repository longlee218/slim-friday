import { DELETE_PATHS_TOOL } from "../../mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";
import { ANY, type DispatchEnvelope } from "./envelope";
import type { EffectTool, RiskClass } from "./risk-types";

/* Per-call check of an effect tool against the run's envelope. Pure; the guard calls it with the scope the tool input
   names, the tool calls it again with the measured items and bytes. */

/** Branch names treated as a default branch when the remote's own default is unknown: the push asks the owner at every act (R4). */
const DEFAULT_BRANCHES: readonly string[] = ["main", "master", "develop", "trunk"];

/** True for a name in the fallback list or a `release*` branch. */
export const isFallbackDefault = (branch: string): boolean =>
  DEFAULT_BRANCHES.includes(branch) || branch.startsWith("release");

/** What the check knows about one call. */
export interface EnvelopeCall {
  tool: EffectTool;
  /** Location name (absent for DeletePaths: its paths are judged one by one). */
  location?: string;
  branch?: string;
  into?: string;
  /** Items and bytes this call would move to the trash (the guard does not know them yet). */
  items?: number;
  bytes?: number;
}

/** `R4` = allowed only with the owner's yes at this act. */
export type EnvelopeVerdict =
  | { allow: true }
  | { allow: false; code: "OUT_OF_ENVELOPE" | "OVER_BOUNDS" | "R4"; reason: string };

/** What the goal's trash already holds (counted from `effect_log`). */
export interface BoundsUsage {
  items: number;
  bytes: number;
}

const deny = (code: "OUT_OF_ENVELOPE" | "OVER_BOUNDS" | "R4", reason: string): EnvelopeVerdict => ({
  allow: false,
  code,
  reason,
});

/** Class of an effect tool when it runs inside its grant. */
export const effectRisk = (tool: EffectTool): RiskClass =>
  tool === DELETE_PATHS_TOOL || tool === MERGE_BRANCH_TOOL ? "R2" : "R3";

/**
 * Decide an effect call. DeletePaths needs no grant: the trash is restorable, so only the bounds (items and bytes of the whole
 * goal) apply. The others need a grant of the same tool on the same location whose branch / into covers the call; a push to
 * a default branch, or a merge into one, is R4 even with a grant. Fail closed: anything unclear is OUT_OF_ENVELOPE.
 */
export function checkEnvelope(
  call: EnvelopeCall,
  env: DispatchEnvelope,
  usage: BoundsUsage = { items: 0, bytes: 0 },
): EnvelopeVerdict {
  if (call.tool === DELETE_PATHS_TOOL) {
    if (usage.items + (call.items ?? 0) > env.bounds.maxItems)
      return deny("OVER_BOUNDS", `more than ${env.bounds.maxItems} items deleted for this goal`);
    if (usage.bytes + (call.bytes ?? 0) > env.bounds.maxBytes)
      return deny("OVER_BOUNDS", "the delete is bigger than the goal's size bound");
    return { allow: true };
  }
  if (!call.location || !env.locations.includes(call.location))
    return deny("OUT_OF_ENVELOPE", "this location is not in the approved envelope");
  const grant = env.effects.find((g) => g.tool === call.tool && g.scope.location === call.location);
  if (!grant) return deny("OUT_OF_ENVELOPE", "this action is not granted for the location");
  if (call.tool === GIT_PUSH_TOOL && call.branch && isFallbackDefault(call.branch))
    return deny("R4", "pushing to a default branch needs the owner at every act");
  // A merge INTO a default branch asks the owner at every act, whatever the grant (`into: "*"` included), like a push to it.
  if (call.tool === MERGE_BRANCH_TOOL && call.into && isFallbackDefault(call.into))
    return deny("R4", "merging into a default branch needs the owner at every act");
  const want = call.tool === MERGE_BRANCH_TOOL ? call.into : call.branch;
  const have = call.tool === MERGE_BRANCH_TOOL ? grant.scope.into : grant.scope.branch;
  if (have !== ANY && (want === undefined || have !== want))
    return deny("OUT_OF_ENVELOPE", "the branch is outside the grant");
  return { allow: true };
}

/**
 * True when the plan's grant of `tool` on `location` names exactly this branch (not `*`): the owner approved that branch itself,
 * so an unreadable remote default cannot make it a surprise. Anything broader is "unknown": the tool asks (fail closed).
 */
export function grantNamesBranch(
  env: DispatchEnvelope,
  tool: EffectTool,
  location: string,
  branch: string,
): boolean {
  const g = env.effects.find((e) => e.tool === tool && e.scope.location === location);
  const named = tool === MERGE_BRANCH_TOOL ? g?.scope.into : g?.scope.branch;
  return named !== undefined && named !== ANY && named === branch;
}
