import type { Effort, Route as ModelRoute, ModelTier, TaskClass } from "../config/model-routing";

/**
 * Route of a run: owner class, owner-forced tier (`[sonnet]`), effort and `go +<usd>` raise; undefined when none is set (role defaults).
 * Effort `max` only arrives here after the owner-confirm gate said yes (`resolveEffort` caps it otherwise), so it
 * carries the confirmation into the model routing.
 */
export const runRoute = (r: {
  cls?: TaskClass;
  tier?: ModelTier;
  effort?: Effort;
  extraBudgetUsd?: number;
}): ModelRoute | undefined =>
  r.cls || r.tier || r.effort || r.extraBudgetUsd
    ? {
        cls: r.cls,
        ...(r.tier && { tier: r.tier }),
        effort: r.effort,
        extraBudgetUsd: r.extraBudgetUsd,
        ...(r.effort === "max" && { ownerConfirmedMax: true }),
      }
    : undefined;
