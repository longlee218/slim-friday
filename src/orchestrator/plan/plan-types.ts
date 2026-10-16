/* Types and limits of a work plan. A plan is DATA: the planner writes it through its tools, code validates it, the owner
   approves it once, and the approved plan IS the envelope the run stays inside. */

/** Risk classes of an item (R4 is never planned: it needs the owner at the moment of the act). */
const RISKS = ["R0", "R1", "R2", "R3"] as const;
export type Risk = (typeof RISKS)[number];

/** How the finished work is handed over. */
export const DELIVERY_MODES = ["merge", "pr", "keep"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Most items one plan may hold. */
export const MAX_ITEMS = 8;
/** Most revisions after version 1. */
export const MAX_REVISIONS = 3;
/** Largest plan body (JSON text of the items), bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Item key prefix of the planner's own items (reserved: a plan item never uses it). */
export const PLANNER_KEY = "planner";

/** An unknown risk word counts as R2 (the cautious middle), never as R0. */
export const normalizeRisk = (r: string): Risk =>
  (RISKS as readonly string[]).includes(r) ? (r as Risk) : "R2";

/** One step of a plan: one worker run. */
export interface PlanItem {
  /** Key unique within the goal. */
  key: string;
  /** Worker role name. */
  role: string;
  /** Self-contained brief: the worker sees only this. */
  brief: string;
  /** Location name; omitted = none. */
  location?: string;
  /** Keys this item waits for (plan keys or earlier finished items of the goal). */
  dependsOn: string[];
  risk: Risk;
  /** True when this item is named but left for a later plan (not run by this one). */
  deferredScope?: boolean;
}

/** What the owner approves and the run must stay inside. `roles` is derived by code from the items. */
export interface Envelope {
  roles: string[];
  locations: string[];
  riskClasses: Risk[];
  bounds: { maxItems: number; maxGb: number };
  budgetUsd: number;
  deliveryMode: DeliveryMode;
}

/** The content of one plan version. */
export interface PlanDoc {
  items: PlanItem[];
  acceptanceCriteria: string[];
  envelope: Envelope;
}

/** Coded validation errors. */
type PlanErrorCode =
  | "NO_ITEMS"
  | "TOO_MANY_ITEMS"
  | "TOO_BIG"
  | "DUP_KEY"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_DEP"
  | "CYCLE"
  | "BAD_LOCATION"
  | "DEAD_DEP"
  | "OUTSIDE_ENVELOPE"
  | "BUDGET"
  | "TOO_MANY_REVISIONS";

/** One validation error (`key` = the item it is about, when any). */
export interface PlanError {
  code: PlanErrorCode;
  message: string;
  key?: string;
}

/** Facts the validator needs from the registries and the goal (never taken from model text). */
export interface PlanCtx {
  /** Names of the roles a plan may use (`dispatchable` data). */
  workerRoles: readonly string[];
  /** Location names of the workspace. */
  locations: readonly string[];
  /** Budget ceiling of the goal, USD. */
  goalBudgetUsd: number;
  /** Keys of items of the goal that are not part of this plan (planner runs, finished earlier work): usable as dependencies, never as new keys. */
  existingKeys: readonly string[];
  /** Keys of the goal's items that ended `failed` / `cancelled`: they never run, so nothing may wait for them (default none). */
  deadKeys?: readonly string[];
  /** Revisions already made (0 for a new plan). */
  revisions: number;
}

/** Id, version and lifecycle status of a stored plan version. */
export interface PlanStatusView {
  planId: string;
  version: number;
  status: string;
}
