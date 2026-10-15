import { z } from "zod";
import {
  CREATE_PULL_REQUEST_TOOL,
  GIT_PUSH_TOOL,
  MERGE_BRANCH_TOOL,
} from "../../mcp/mcp-tool-names";
import {
  OPTION_MAX_CHARS,
  OPTIONS_MAX,
  OPTIONS_MIN,
  QUESTION_MAX_CHARS,
} from "../../tools/AskOwnerTool/constants";
import {
  BRIEF_MAX_CHARS,
  MAX_ASSIGNMENTS,
  REASON_MAX_CHARS,
} from "../../tools/DispatchAgentTool/constants";
import {
  MAX_REQUESTS,
  REQUEST_MAX_CHARS,
  SUMMARY_MAX_CHARS,
} from "../../tools/ReportResultTool/constants";
import { STEER_TEXT_MAX_CHARS } from "../../tools/SteerTaskTool/constants";
import { RESULT_KINDS } from "../strategy/typed-result";

/* Input schemas (zod raw shapes) of the lead's tools and of the worker's ReportResult. The SDK validates a call
   against them before any handler runs; the handlers' input types are inferred from the same shapes. */

/** Item key: a short slug (it becomes a file name segment). */
export const KEY = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
/** Task id as given by the status and dispatch tools. */
export const TASK_ID = z.string().min(1).max(80);

/** One worker assignment. */
export const ASSIGNMENT = z.object({
  key: KEY.describe("Unique within this dispatch, e.g. main"),
  role: z.string().min(1).max(40).describe("Worker role name from the roster"),
  brief: z.string().min(1).max(BRIEF_MAX_CHARS).describe("What the worker must do, self-contained"),
  location: z.string().min(1).max(80).optional().describe("Location name; omit when none"),
  dependsOn: z.array(KEY).max(3).default([]).describe("Keys this assignment waits for"),
});

/** One effect action the workers need beyond the default envelope; the owner is asked once at dispatch. */
export const EFFECT_GRANT = z.object({
  tool: z.enum([GIT_PUSH_TOOL, CREATE_PULL_REQUEST_TOOL, MERGE_BRANCH_TOOL]),
  location: z.string().min(1).max(80),
  branch: z.string().min(1).max(100).optional().describe("GitPush / CreatePullRequest: the branch"),
  into: z.string().min(1).max(100).optional().describe("MergeBranch: the branch merged into"),
});

export const DISPATCH_AGENT_SHAPE = {
  strategy: z.enum(["DIRECT", "DELEGATE"]),
  intent: z.string().min(1).max(REASON_MAX_CHARS).describe("The goal in one sentence"),
  reason: z.string().min(1).max(REASON_MAX_CHARS).describe("Why this strategy and these workers"),
  supersedes: TASK_ID.optional().describe("Id of the open goal this replaces"),
  assignments: z.array(ASSIGNMENT).min(1).max(MAX_ASSIGNMENTS),
  effects: z
    .array(EFFECT_GRANT)
    .max(6)
    .optional()
    .describe("Push / PR / merge the workers need, e.g. the owner asked for a PR"),
};
export const TASK_STATUS_SHAPE = { taskId: TASK_ID.optional() };
export const STEER_TASK_SHAPE = {
  taskId: TASK_ID,
  text: z.string().min(1).max(STEER_TEXT_MAX_CHARS),
};
export const CANCEL_TASK_SHAPE = {
  taskId: TASK_ID,
  reason: z.string().min(1).max(REASON_MAX_CHARS),
};
export const ASK_OWNER_SHAPE = {
  question: z.string().min(1).max(QUESTION_MAX_CHARS),
  options: z.array(z.string().min(1).max(OPTION_MAX_CHARS)).min(OPTIONS_MIN).max(OPTIONS_MAX),
  taskId: TASK_ID.optional(),
  workerAskId: z.string().min(1).max(80).optional(),
};
export const FORWARD_RESULT_SHAPE = { taskId: TASK_ID, mode: z.enum(["verbatim", "summary"]) };
export const REQUEST_ESCALATION_SHAPE = {
  to: z.enum(["high", "opus"]),
  reason: z.string().min(1).max(REASON_MAX_CHARS),
};

/** A follow-up the worker asks for next to its result. */
export const WORKER_REQUEST = z.object({
  kind: z.enum(["question", "capability", "plan"]),
  text: z.string().min(1).max(REQUEST_MAX_CHARS),
});
export const REPORT_RESULT_SHAPE = {
  status: z.enum(RESULT_KINDS as [string, ...string[]]),
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS),
  requests: z.array(WORKER_REQUEST).max(MAX_REQUESTS).optional(),
};

/** Parsed inputs, one per tool. */
export type DispatchInput = z.infer<z.ZodObject<typeof DISPATCH_AGENT_SHAPE>>;
export type TaskStatusInput = z.infer<z.ZodObject<typeof TASK_STATUS_SHAPE>>;
export type SteerInput = z.infer<z.ZodObject<typeof STEER_TASK_SHAPE>>;
export type CancelInput = z.infer<z.ZodObject<typeof CANCEL_TASK_SHAPE>>;
export type AskOwnerInput = z.infer<z.ZodObject<typeof ASK_OWNER_SHAPE>>;
export type ForwardInput = z.infer<z.ZodObject<typeof FORWARD_RESULT_SHAPE>>;
export type EscalationInput = z.infer<z.ZodObject<typeof REQUEST_ESCALATION_SHAPE>>;
export type ReportInput = z.infer<z.ZodObject<typeof REPORT_RESULT_SHAPE>>;
