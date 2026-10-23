import { z } from "zod";
import { BLOCKER_REASON_MAX_CHARS, BRIEF_MAX_CHARS } from "./teammate-limits";
import {
  CONFIRM_NEW,
  KEY,
  PRIORITY_FIELD,
  PRIORITY_VALUE,
  SUBJECT,
  TASK_ID,
} from "./teammate-schemas";

/* Input schemas (zod raw shapes) of the task tools: the teammate's add / update and the worker's blocker. */

/** Orchestrate add: one item in the teammate's open goal (DIRECT / DELEGATE). */
export const ADD_ITEM_SHAPE = {
  goalId: TASK_ID.optional().describe("The open goal; omit for the thread's open goal"),
  key: KEY.describe("Unique within the goal"),
  subject: SUBJECT,
  role: z.string().min(1).max(40).describe("Worker role name from the roster"),
  brief: z.string().min(1).max(BRIEF_MAX_CHARS).describe("What the worker must do, self-contained"),
  location: z.string().min(1).max(80).optional().describe("Location name; omit when none"),
  dependsOn: z.array(KEY).max(3).default([]).describe("Keys of items of this goal it waits for"),
  priority: PRIORITY_FIELD,
  confirmNew: CONFIRM_NEW,
};
/** Orchestrate update: change a task that has not started (pending / ready). */
export const UPDATE_ITEM_SHAPE = {
  taskId: TASK_ID,
  subject: SUBJECT.optional(),
  brief: z.string().min(1).max(BRIEF_MAX_CHARS).optional(),
  priority: PRIORITY_VALUE.optional(),
  dependsOn: z.array(KEY).max(3).optional().describe("Full replacement of the keys it waits for"),
  role: z.string().min(1).max(40).optional(),
};
/** Why a worker cannot go on and what it needs from outside. */
export const BLOCKER_NEEDS = ["answer", "access", "decision", "other"] as const;
export const REPORT_BLOCKER_SHAPE = {
  reason: z
    .string()
    .min(1)
    .max(BLOCKER_REASON_MAX_CHARS)
    .describe("What blocks you and what unblocks it"),
  needs: z.enum(BLOCKER_NEEDS),
};

export type AddItemInput = z.infer<z.ZodObject<typeof ADD_ITEM_SHAPE>>;
export type UpdateItemInput = z.infer<z.ZodObject<typeof UPDATE_ITEM_SHAPE>>;
export type BlockerInput = z.infer<z.ZodObject<typeof REPORT_BLOCKER_SHAPE>>;
