import { z } from "zod";
import { BLOCKER_REASON_MAX_CHARS, BRIEF_MAX_CHARS, SEARCH_QUERY_MAX_CHARS } from "./lead-limits";
import { CONFIRM_NEW, KEY, PRIORITY_FIELD, PRIORITY_VALUE, SUBJECT, TASK_ID } from "./lead-schemas";

/* Input schemas (zod raw shapes) of the task tools: the lead's add / update / get / search and the worker's blocker.
   get and search are used by the lead's Orchestrate tool. */

/** Orchestrate add: one item in the lead's open goal (DIRECT / DELEGATE). */
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
/** `get` of the lead (`Orchestrate`): one task or goal. */
export const GET_TASK_SHAPE = { taskId: TASK_ID };
/** `search` of the lead: the thread's goals and tasks by subject and brief. */
export const SEARCH_TASKS_SHAPE = {
  query: z.string().min(1).max(SEARCH_QUERY_MAX_CHARS).describe("Words of the task you look for"),
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
export type GetTaskInput = z.infer<z.ZodObject<typeof GET_TASK_SHAPE>>;
export type SearchTasksInput = z.infer<z.ZodObject<typeof SEARCH_TASKS_SHAPE>>;
export type BlockerInput = z.infer<z.ZodObject<typeof REPORT_BLOCKER_SHAPE>>;
