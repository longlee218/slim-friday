import { PLAN_MAX_ITEMS } from "../../../../config/lead-caps";

/** Description the model reads for the `CreatePlan` tool. */
export const CREATE_PLAN_DESCRIPTION = `Store the plan (version 1): up to ${PLAN_MAX_ITEMS} items (key, role, brief, optional location, dependsOn, risk R0-R3), acceptance criteria, the envelope (locations, riskClasses, bounds) the owner will approve, budgetUsd and effects (the delivery tools the plan grants: GitPush, CreatePullRequest, MergeBranch; [] = keep the work local). Code validates it: valid, or coded errors (NO_ITEMS, TOO_MANY_ITEMS, DUP_KEY, UNKNOWN_ROLE, UNKNOWN_DEP, CYCLE, BAD_LOCATION, OUTSIDE_ENVELOPE, BUDGET) - fix and call again. A goal has one plan: later changes go through ProposePlanRevision.`;
