import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";

/* Types and limits of a work plan. A plan is DATA: the planner writes it through its tools, code validates it, the owner
   approves it once, and the approved plan IS the envelope the run stays inside. */

/** Risk classes of an item (R4 is never planned: it needs the owner at the moment of the act). */
const RISKS = ["R0", "R1", "R2", "R3"] as const;
export type Risk = (typeof RISKS)[number];

/** Effect tools a plan may grant for handing the finished work over (push + PR, or merge); none listed = keep it local. */
export const DELIVERY_EFFECT_TOOLS = [
  GIT_PUSH_TOOL,
  CREATE_PULL_REQUEST_TOOL,
  MERGE_BRANCH_TOOL,
] as const;
export type DeliveryEffect = (typeof DELIVERY_EFFECT_TOOLS)[number];

/** Item key prefix of the planner's own items (reserved: a plan item never uses it). */
export const PLANNER_KEY = "planner";

/** Key prefixes of the items code appends (verify and fix, see goal-verify.ts): reserved, a plan item never uses them. */
export const VERIFY_KEY = "verify";
export const FIX_KEY = "fix";

/** Role that runs the verify item (Haiku; it has the `shell` capability, so it can run the checks). */
export const VERIFY_ROLE = "tester";

/** Error text of a plan budget that is not above what the goal already spent (validator and approval; the planner prompt says the same). */
export const budgetSpentMessage = (budgetUsd: number, spentUsd: number): string =>
  `Budget $${budgetUsd} must be above what the goal already spent ($${spentUsd.toFixed(2)}: the planner and earlier items count). Raise budgetUsd.`;

/** What a plan item key may not look like (named in the validator error): planner items and the code-made `verify-N` / `fix-N`. */
export const RESERVED_KEY_PATTERN = "planner*, verify-N, fix-N";
const CODE_KEY = new RegExp(`^(${VERIFY_KEY}|${FIX_KEY})-\\d+$`);

/** True for a key a plan item may not use (`fixtures`, `verify-tests`, `fix-login` are legal). */
export const isReservedKey = (key: string): boolean =>
  key.startsWith(PLANNER_KEY) || CODE_KEY.test(key);

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
  /** Short label (<= 80 chars) shown in lists, digests and the plan notice. */
  subject: string;
  /** Urgency 10 (high) or 100 (urgent); omitted = 0 (normal). */
  priority?: number;
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
  /** Delivery effect tools the plan grants on its locations (the envelope `effects`); empty = nothing leaves the location. */
  effects: DeliveryEffect[];
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
  | "DUP_KEY"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_DEP"
  | "CYCLE"
  | "BAD_LOCATION"
  | "DEAD_DEP"
  | "RELEASED_DEP"
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
  /** Keys of held NEEDS_PLANNING items the first approval cancels: nothing may wait for them (default none). */
  releasedKeys?: readonly string[];
  /** Revisions already made (0 for a new plan). */
  revisions: number;
  /** USD the goal already spent (the planner and earlier items): the plan budget must exceed it (default 0). */
  spentUsd?: number;
}

/** Id, version and lifecycle status of a stored plan version. */
export interface PlanStatusView {
  planId: string;
  version: number;
  status: string;
}
