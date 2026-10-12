import type { Effort, Route as ModelRoute, TaskClass } from "../config/model-routing";

/**
 * Route of a run: owner class, effort and `go +<usd>` raise; undefined when none is set (role defaults).
 * Effort `max` only arrives here after the owner-confirm gate said yes (`resolveEffort` caps it otherwise), so it
 * carries the confirmation into the model routing.
 */
export const runRoute = (r: {
  cls?: TaskClass;
  effort?: Effort;
  extraBudgetUsd?: number;
}): ModelRoute | undefined =>
  r.cls || r.effort || r.extraBudgetUsd
    ? {
        cls: r.cls,
        effort: r.effort,
        extraBudgetUsd: r.extraBudgetUsd,
        ...(r.effort === "max" && { ownerConfirmedMax: true }),
      }
    : undefined;
