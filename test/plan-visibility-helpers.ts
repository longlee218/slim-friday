import {
  createPlanHandler,
  type PlannerCtx,
  proposeRevisionHandler,
} from "../src/orchestrator/plan/planner-handlers";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { ENV, type item, TH } from "./waves-fixture";

/** A planner ctx over the db of a world (no notify: the test reads the db). */
export const plannerCtxOf = (
  deps: { db: PlannerCtx["db"] },
  goalId: string,
  extra: Partial<PlannerCtx> = {},
): PlannerCtx => ({
  db: deps.db,
  threadId: TH,
  goalId,
  workers: dispatchableWorkers(),
  locations: ENV.locations.map((name) => ({ name, path: `/x/${name}` })),
  channelDigest: () => "",
  ...extra,
});

/** Run one planner tool call on `app` (a plan ctx): a revision of v1 (`add`, `cancel`) or, with `replan`, a new plan. */
export function createPlanHandlerFor(
  app: PlannerCtx,
  planId: string,
  o: {
    add?: ReturnType<typeof item>[];
    cancel?: string[];
    replan?: ReturnType<typeof item>[];
    grow?: boolean;
  },
) {
  if (o.replan)
    return createPlanHandler(app, {
      goalId: app.goalId,
      items: o.replan,
      acceptanceCriteria: ["works"],
      envelope: {
        locations: ["repo"],
        riskClasses: ["R0", "R1"],
        bounds: { maxItems: 8, maxGb: 1 },
      },
      effects: [],
      confirmNew: true,
    } as never);
  return proposeRevisionHandler(app, {
    planId,
    baseVersion: 1,
    add: o.add ?? [],
    cancel: o.cancel ?? [],
    modify: [],
    reason: "changed",
    ...(o.grow && {
      envelope: {
        locations: ["repo", "docs"],
        riskClasses: ["R0", "R1"],
        bounds: { maxItems: 8, maxGb: 1 },
      },
    }),
  } as never);
}
