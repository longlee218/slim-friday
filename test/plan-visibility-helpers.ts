import type { Database } from "bun:sqlite";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import type { RevisionDiff } from "../src/orchestrator/plan/plan-revised";
import type {
  CreateLeadPlanInput,
  ProposeRevisionInput,
} from "../src/orchestrator/plan/plan-schemas";
import { ENV, type item, TH } from "./plan-fixture";

/** The world of a lead plan call: the db, the goal and the side effects the lead handler runs after a stored version. */
export interface PlanApp {
  db: Database;
  goalId: string;
  /** A version was stored (the handler saves the plan artifact). */
  onVersion?: () => void;
  /** A re-plan changed the plan (the handler posts the owner line). */
  notify?: (diff: RevisionDiff) => void;
}

/** A plan app over the db of a world (no hooks: the test reads the db). */
export const plannerCtxOf = (
  deps: { db: Database },
  goalId: string,
  extra: Pick<PlanApp, "onVersion" | "notify"> = {},
): PlanApp => ({ db: deps.db, goalId, ...extra });

const portOf = (app: PlanApp) =>
  createPlanPort(app.db, TH, undefined, () => ({
    workerRoles: ENV.workerRoles,
    locations: ENV.locations,
  }));

/** `Orchestrate create_plan` as the lead handler runs it: the port write, then the artifact sync and the owner line. */
export function createPlanFor(
  app: PlanApp,
  input: Omit<CreateLeadPlanInput, "objective" | "goalId"> & { objective?: string },
) {
  const w = portOf(app).createPlan({
    objective: "build it",
    goalId: app.goalId,
    ...input,
  } as CreateLeadPlanInput);
  if (w.ok) {
    app.onVersion?.();
    if (w.diff) app.notify?.(w.diff);
  }
  return w;
}

/** `Orchestrate revise_plan` as the lead handler runs it: the port write, then the artifact sync. */
export function revisePlanFor(app: PlanApp, input: ProposeRevisionInput) {
  const { planId, baseVersion, reason, ...edit } = input;
  const w = portOf(app).revisePlan({ planId, baseVersion, reason, edit });
  if (w.ok) app.onVersion?.();
  return w;
}

/** One lead plan call on `app`: a revision of v1 (`add`, `cancel`) or, with `replan`, a new plan. */
export function createPlanHandlerFor(
  app: PlanApp,
  planId: string,
  o: {
    add?: ReturnType<typeof item>[];
    cancel?: string[];
    replan?: ReturnType<typeof item>[];
    grow?: boolean;
  },
) {
  if (o.replan)
    return createPlanFor(app, {
      items: o.replan,
      acceptanceCriteria: ["works"],
      envelope: {
        locations: ["repo"],
        riskClasses: ["R0", "R1"],
        bounds: { maxItems: 8, maxGb: 1 },
      },
      effects: [],
      confirmNew: true,
    });
  return revisePlanFor(app, {
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
