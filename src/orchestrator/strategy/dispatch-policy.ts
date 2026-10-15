import {
  type Caps,
  CHAIN_CAP,
  DELEGATE_MAX,
  DISPATCHES_PER_RUN,
  type GoalState,
  LEAD_DAILY_BUDGET_USD,
  type PolicyEnv,
} from "./caps";

/* Pure dispatch policy: the lead picked a typed action; this decides whether code allows it. No db, no clock. */

/** One worker assignment of a dispatch request. */
export interface Assignment {
  /** Key unique within the goal. */
  key: string;
  role: string;
  brief: string;
  location?: string;
  /** Keys of the assignments this one waits for. */
  dependsOn: string[];
}

/** A dispatch request as the policy reads it. */
export interface DispatchReq {
  strategy: "DIRECT" | "DELEGATE";
  assignments: Assignment[];
  /** Id of the open goal this request replaces (required while a goal is open). */
  supersedes?: string;
}

/** Refusal codes, checked in this order. */
export type RefusalCode =
  | "ONE_PER_RUN"
  | "BUDGET"
  | "CHAIN_CAP"
  | "GOAL_OPEN"
  | "BAD_TASK"
  | "TOO_MANY"
  | "NOT_WORKER"
  | "BAD_LOCATION"
  | "CYCLE"
  | "NEEDS_PLAN";

/** An accepted item: the assignment plus the status it starts in (no dependency = `ready`). */
export interface ItemDraft extends Assignment {
  status: "ready" | "pending";
}

/** The policy answer. */
export type DispatchCheck =
  | { ok: true; items: ItemDraft[] }
  | { ok: false; code: RefusalCode; message: string };

const refuse = (code: RefusalCode, message: string): DispatchCheck => ({
  ok: false,
  code,
  message,
});

/**
 * Shape of the dependencies: `bad` = a duplicate key, an unknown key, a self or cyclic dependency; `branching` = an item
 * that waits for two others or is waited on by two (only a chain is allowed without a plan); `chain` otherwise.
 */
export function depsShape(a: readonly Assignment[]): "chain" | "branching" | "bad" {
  const keys = new Set(a.map((x) => x.key));
  if (keys.size !== a.length) return "bad";
  const waitedOn = new Map<string, number>();
  for (const x of a)
    for (const d of x.dependsOn) {
      if (!keys.has(d) || d === x.key) return "bad";
      waitedOn.set(d, (waitedOn.get(d) ?? 0) + 1);
    }
  // Kahn's algorithm: everything must be removable, else there is a cycle.
  const left = new Map(a.map((x) => [x.key, new Set(x.dependsOn)] as const));
  let progressed = true;
  while (left.size && progressed) {
    progressed = false;
    for (const [k, deps] of left)
      if (deps.size === 0) {
        left.delete(k);
        for (const d of left.values()) d.delete(k);
        progressed = true;
      }
  }
  if (left.size) return "bad";
  const branching =
    a.some((x) => x.dependsOn.length > 1) || [...waitedOn.values()].some((n) => n > 1);
  return branching ? "branching" : "chain";
}

/**
 * Check a dispatch request against the caps and the registries. First failing rule wins (the order below).
 * Success returns the items to create: no dependency = `ready`, otherwise `pending`.
 */
export function checkDispatch(
  state: GoalState,
  req: DispatchReq,
  caps: Caps,
  env: PolicyEnv,
): DispatchCheck {
  if (caps.dispatchedThisRun >= DISPATCHES_PER_RUN)
    return refuse(
      "ONE_PER_RUN",
      "One dispatch per lead run: wait for the result, then dispatch again.",
    );
  if (caps.leadSpentTodayUsd >= LEAD_DAILY_BUDGET_USD)
    return refuse("BUDGET", "The lead's daily budget is spent: nothing more is dispatched today.");
  if (state.openGoalId && req.supersedes !== state.openGoalId)
    return refuse(
      "GOAL_OPEN",
      `Goal ${state.openGoalId} is open: set supersedes to its id or wait.`,
    );
  // `supersedes` names the open goal or nothing: any other id (stale, foreign) is refused, never acted on.
  if (req.supersedes && req.supersedes !== state.openGoalId)
    return refuse("BAD_TASK", `Goal ${req.supersedes} is not this thread's open goal.`);
  const n = req.assignments.length; // the schema guarantees at least one
  if (req.strategy === "DIRECT" && n !== 1)
    return refuse("TOO_MANY", "DIRECT takes exactly one assignment.");
  const unknown = req.assignments.find((a) => !env.workerRoles.includes(a.role));
  if (unknown) return refuse("NOT_WORKER", `Role ${unknown.role} is not a dispatchable worker.`);
  const badLoc = req.assignments.find((a) => a.location && !env.locations.includes(a.location));
  if (badLoc)
    return refuse("BAD_LOCATION", `Location ${badLoc.location} is not in this workspace.`);
  const shape = depsShape(req.assignments);
  if (shape === "bad")
    return refuse("CYCLE", "dependsOn must name other keys of this request, without a cycle.");
  if (n > DELEGATE_MAX || shape === "branching")
    return refuse(
      "NEEDS_PLAN",
      `DELEGATE takes up to ${DELEGATE_MAX} chained workers: a bigger shape needs a plan.`,
    );
  // Every assignment is one `start`: the chain after this request must stay within the cap (checked last, so a
  // request that is too big answers NEEDS_PLAN rather than CHAIN_CAP).
  if (caps.chainCount + n > CHAIN_CAP)
    return refuse(
      "CHAIN_CAP",
      `At most ${CHAIN_CAP} chained starts without an owner message (${caps.chainCount} used): ask the owner first.`,
    );
  return {
    ok: true,
    items: req.assignments.map((a) => ({ ...a, status: a.dependsOn.length ? "pending" : "ready" })),
  };
}
