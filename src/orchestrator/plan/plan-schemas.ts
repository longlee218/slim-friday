import { z } from "zod";
import { PLAN_MAX_CRITERIA, PLAN_MAX_ITEMS } from "../../config/teammate-caps";
import {
  BRIEF_MAX_CHARS,
  PLAN_DOC_MAX_CHARS,
  PLAN_SECTION_MAX_CHARS,
  REASON_MAX_CHARS,
} from "../teammate/teammate-limits";
import {
  CONFIRM_NEW,
  KEY,
  PRIORITY_FIELD,
  PRIORITY_VALUE,
  SUBJECT,
  TASK_ID,
} from "../teammate/teammate-schemas";
import { DELIVERY_EFFECT_TOOLS } from "./plan-types";

/* Input schemas (zod raw shapes) of the teammate's Orchestrate create_plan / revise_plan / approve_plan. The SDK
   validates a call against them before any handler runs; the handler input types are inferred from the same shapes. */

/** A heading of the plan text that holds this item's part of the plan (its text goes into the item's brief). */
const SECTION = z
  .string()
  .min(1)
  .max(PLAN_SECTION_MAX_CHARS)
  .optional()
  .describe("Heading of `plan` with this item's part (its text is added to the brief)");

/** One plan item. The risk is free text here: code turns an unknown word into R2. */
const PLAN_ITEM = z.object({
  key: KEY.describe("Unique within the goal; never looks like verify-N / fix-N (reserved)"),
  subject: SUBJECT,
  priority: PRIORITY_FIELD,
  role: z.string().min(1).max(40).describe("Worker role name (see <team>)"),
  brief: z
    .string()
    .min(1)
    .max(BRIEF_MAX_CHARS)
    .describe("Self-contained: the worker sees only this"),
  section: SECTION,
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

export const CREATE_PLAN_SHAPE = {
  goalId: TASK_ID,
  items: z.array(PLAN_ITEM).min(1).max(PLAN_MAX_ITEMS),
  acceptanceCriteria: z.array(z.string().min(1).max(300)).max(PLAN_MAX_CRITERIA),
  envelope: ENVELOPE,
  effects: EFFECTS,
  confirmNew: CONFIRM_NEW,
};
/** The teammate's `create_plan`: the plan shape plus the objective; no `goalId` opens a new goal, `goalId` plans inside the open one. */
export const CREATE_TEAMMATE_PLAN_SHAPE = {
  objective: z.string().min(1).max(2000).describe("What the owner wants, in the owner's terms"),
  goalId: TASK_ID.optional().describe(
    "Plan inside this open goal (re-plan after a reject or an expiry)",
  ),
  spec: z
    .string()
    .min(1)
    .max(PLAN_DOC_MAX_CHARS)
    .describe("The spec, markdown: what is built and why (stored once, workers read it on demand)"),
  plan: z
    .string()
    .min(1)
    .max(PLAN_DOC_MAX_CHARS)
    .describe("The plan, markdown, one heading per part; items name a heading in `section`"),
  items: CREATE_PLAN_SHAPE.items,
  acceptanceCriteria: CREATE_PLAN_SHAPE.acceptanceCriteria,
  envelope: CREATE_PLAN_SHAPE.envelope,
  effects: CREATE_PLAN_SHAPE.effects,
  confirmNew: CREATE_PLAN_SHAPE.confirmNew,
};
export const PROPOSE_REVISION_SHAPE = {
  planId: PLAN_ID,
  baseVersion: VERSION,
  add: z.array(PLAN_ITEM).max(PLAN_MAX_ITEMS).default([]),
  cancel: z.array(KEY).max(PLAN_MAX_ITEMS).default([]),
  modify: z
    .array(
      z.object({
        key: KEY,
        subject: SUBJECT.optional(),
        priority: PRIORITY_VALUE.optional(),
        brief: z.string().min(1).max(BRIEF_MAX_CHARS).optional(),
        section: SECTION,
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
  spec: z
    .string()
    .min(1)
    .max(PLAN_DOC_MAX_CHARS)
    .optional()
    .describe("Full replacement; omit to keep the spec"),
  plan: z
    .string()
    .min(1)
    .max(PLAN_DOC_MAX_CHARS)
    .optional()
    .describe("Full replacement; omit to keep the plan text"),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
  envelope: ENVELOPE.optional().describe("Full replacement; omit to keep the approved one"),
  effects: EFFECTS.optional(),
};
export const APPROVE_PLAN_SHAPE = { planId: PLAN_ID, version: VERSION };

/** Parsed inputs, one per tool. */
type Input<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export type CreateTeammatePlanInput = Input<typeof CREATE_TEAMMATE_PLAN_SHAPE>;
export type ProposeRevisionInput = Input<typeof PROPOSE_REVISION_SHAPE>;
export type ApprovePlanInput = Input<typeof APPROVE_PLAN_SHAPE>;
