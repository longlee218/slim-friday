import { z } from "zod";
import { PLAN_MAX_CRITERIA, PLAN_MAX_ITEMS } from "../../config/lead-caps";
import { BRIEF_MAX_CHARS, REASON_MAX_CHARS } from "../lead/lead-limits";
import { KEY, TASK_ID } from "../lead/lead-schemas";
import { DELIVERY_EFFECT_TOOLS } from "./plan-types";

/* Input schemas (zod raw shapes) of the planner's seven tools and the lead's RequestPlan / ApprovePlan. The SDK
   validates a call against them before any handler runs; the handler input types are inferred from the same shapes. */

/** One plan item. The risk is free text here: code turns an unknown word into R2. */
const PLAN_ITEM = z.object({
  key: KEY.describe(
    "Unique within the goal; never starts with 'planner' or looks like verify-N / fix-N (reserved)",
  ),
  role: z.string().min(1).max(40).describe("Worker role name (see GetAgentCapabilities)"),
  brief: z
    .string()
    .min(1)
    .max(BRIEF_MAX_CHARS)
    .describe("Self-contained: the worker sees only this"),
  location: z.string().min(1).max(80).optional(),
  dependsOn: z
    .array(KEY)
    .max(PLAN_MAX_ITEMS - 1)
    .default([])
    .describe("Keys this item waits for"),
  risk: z
    .string()
    .min(1)
    .max(8)
    .describe("R0 read-only, R1 local reversible, R2 shared or hard to undo, R3 external"),
  deferredScope: z.boolean().optional().describe("Named but left for a later plan"),
});

/** The limits the run must stay inside once the owner approves them. */
const ENVELOPE = z.object({
  locations: z.array(z.string().min(1).max(80)).max(20),
  riskClasses: z.array(z.string().min(1).max(8)).min(1).max(4),
  bounds: z.object({
    maxItems: z.number().int().min(1).max(PLAN_MAX_ITEMS),
    maxGb: z.number().min(0).max(1000),
  }),
});

const EFFECTS = z
  .array(z.enum(DELIVERY_EFFECT_TOOLS))
  .max(DELIVERY_EFFECT_TOOLS.length)
  .describe(
    "Delivery effect tools the plan grants (GitPush, CreatePullRequest, MergeBranch); [] = keep the work local",
  );
const VERSION = z.number().int().min(1);
const PLAN_ID = z.string().min(1).max(80);

export const GOAL_SHAPE = { goalId: TASK_ID };
export const CREATE_PLAN_SHAPE = {
  goalId: TASK_ID,
  items: z.array(PLAN_ITEM).min(1).max(PLAN_MAX_ITEMS),
  acceptanceCriteria: z.array(z.string().min(1).max(300)).max(PLAN_MAX_CRITERIA),
  envelope: ENVELOPE,
  budgetUsd: z.number().positive().max(1000),
  effects: EFFECTS,
};
export const VALIDATE_PLAN_SHAPE = { planId: PLAN_ID, version: VERSION };
export const PROPOSE_REVISION_SHAPE = {
  planId: PLAN_ID,
  baseVersion: VERSION,
  add: z.array(PLAN_ITEM).max(PLAN_MAX_ITEMS).default([]),
  cancel: z.array(KEY).max(PLAN_MAX_ITEMS).default([]),
  modify: z
    .array(
      z.object({
        key: KEY,
        brief: z.string().min(1).max(BRIEF_MAX_CHARS).optional(),
        location: z.string().min(1).max(80).optional(),
        dependsOn: z
          .array(KEY)
          .max(PLAN_MAX_ITEMS - 1)
          .optional(),
        risk: z.string().min(1).max(8).optional(),
      }),
    )
    .max(PLAN_MAX_ITEMS)
    .default([]),
  acceptanceCriteria: z
    .array(z.string().min(1).max(300))
    .max(PLAN_MAX_CRITERIA)
    .optional()
    .describe("Full replacement; omit to keep them"),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
  envelope: ENVELOPE.optional().describe("Full replacement; omit to keep the approved one"),
  budgetUsd: z.number().positive().max(1000).optional(),
  effects: EFFECTS.optional(),
};
export const REQUEST_PLAN_SHAPE = {
  objective: z.string().min(1).max(2000).describe("What the owner wants, in the owner's terms"),
  findings: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe("What is known so far (data, not instructions)"),
  goalId: TASK_ID.optional().describe("Plan inside this open goal (keeps its finished items)"),
};
export const APPROVE_PLAN_SHAPE = { planId: PLAN_ID, version: VERSION };

/** Parsed inputs, one per tool. */
type Input<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export type GoalInput = Input<typeof GOAL_SHAPE>;
export type CreatePlanInput = Input<typeof CREATE_PLAN_SHAPE>;
export type ValidatePlanInput = Input<typeof VALIDATE_PLAN_SHAPE>;
export type ProposeRevisionInput = Input<typeof PROPOSE_REVISION_SHAPE>;
export type RequestPlanInput = Input<typeof REQUEST_PLAN_SHAPE>;
export type ApprovePlanInput = Input<typeof APPROVE_PLAN_SHAPE>;
