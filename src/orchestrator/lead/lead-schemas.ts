import { z } from "zod";
import { REPORT_ARTIFACTS_MAX, REPORT_IMAGES_MAX } from "../../artifacts/artifact-limits";
import { PRIORITY_VALUES, SUBJECT_MAX_CHARS } from "../../config/lead-caps";
import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";
import { RESULT_KINDS } from "../../roles/typed-result";
import {
  BLOCKER_REASON_MAX_CHARS,
  BRIEF_MAX_CHARS,
  MAX_ASSIGNMENTS,
  MAX_REQUESTS,
  OPTION_MAX_CHARS,
  OPTIONS_MAX,
  PATH_MAX_CHARS,
  PROGRESS_NOTE_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  QUESTION_MAX_CHARS,
  REASON_MAX_CHARS,
  REPORT_SUMMARY_MAX_CHARS,
  REQUEST_MAX_CHARS,
  SEARCH_QUERY_MAX_CHARS,
  STEER_TEXT_MAX_CHARS,
} from "./lead-limits";

/* Input schemas (zod raw shapes) of the lead's tools and of the worker's Report result. The SDK validates a call
   against them before any handler runs; the handlers' input types are inferred from the same shapes. */

/** Item key: a short slug (it becomes a file name segment). */
export const KEY = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
/** Task id as given by the status and dispatch tools. */
export const TASK_ID = z.string().min(1).max(80);

/** Short label of an item (the list / digest / plan line); `brief` stays the full description. */
export const SUBJECT = z
  .string()
  .min(1)
  .max(SUBJECT_MAX_CHARS)
  .describe("Short label of the task, at most 80 chars; brief is the description");
/** Urgency of an item: 0 normal (omitted = 0), 10 high, 100 urgent. Ready items start by priority, then age; a running item is not preempted. */
export const PRIORITY_VALUE = z
  .literal([...PRIORITY_VALUES])
  .describe("0 normal, 10 high, 100 urgent");
export const PRIORITY_FIELD = PRIORITY_VALUE.optional();
/** Repeat a call that `DUPLICATE_SUSPECT` refused when the work really is new. */
export const CONFIRM_NEW = z
  .boolean()
  .optional()
  .describe("true = it is new work even though a similar task exists");

/** One worker assignment. */
const ASSIGNMENT = z.object({
  key: KEY.describe("Unique within this dispatch, e.g. main"),
  subject: SUBJECT,
  priority: PRIORITY_FIELD,
  role: z.string().min(1).max(40).describe("Worker role name from the roster"),
  brief: z.string().min(1).max(BRIEF_MAX_CHARS).describe("What the worker must do, self-contained"),
  location: z.string().min(1).max(80).optional().describe("Location name; omit when none"),
  dependsOn: z.array(KEY).max(3).default([]).describe("Keys this assignment waits for"),
});

/** One effect action the workers need beyond the default envelope; the owner is asked once at dispatch. */
const EFFECT_GRANT = z.object({
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
  confirmNew: CONFIRM_NEW,
  small: z
    .boolean()
    .optional()
    .describe(
      "true = a SMALL change: one fix or one edit in one file, nothing the owner would call a feature. Required to dispatch a role that writes; anything bigger takes request_plan",
    ),
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
export const RETRY_TASK_SHAPE = {
  taskId: TASK_ID,
  note: z.string().min(1).max(STEER_TEXT_MAX_CHARS).describe("What to fix or change on the retry"),
};
/** How `Orchestrate ask_owner` collects the answer: Yes/No buttons, a pick among options, or typed text. */
export const ASK_KINDS = ["yesno", "select", "text"] as const;
export const ASK_OWNER_SHAPE = {
  question: z.string().min(1).max(QUESTION_MAX_CHARS),
  kind: z
    .enum(ASK_KINDS)
    .describe(
      "yesno: Yes/No buttons, no options. select: 2-25 options. text: the owner types the answer, no options.",
    ),
  options: z.array(z.string().min(1).max(OPTION_MAX_CHARS)).max(OPTIONS_MAX).optional(),
  taskId: TASK_ID.optional(),
  workerAskId: z.string().min(1).max(80).optional(),
};
export const REGISTER_LOCATION_SHAPE = {
  path: z
    .string()
    .min(1)
    .max(PATH_MAX_CHARS)
    .optional()
    .describe(
      "Directory path exactly as the owner wrote it in the current message or answer. Omit it with create:true to use the channel's default projects dir, else the agent's projects folder",
    ),
  create: z
    .boolean()
    .optional()
    .describe(
      "true = make a NEW project (mkdir, git init, README, first commit) at path, or under the channel's default projects dir (else the agent's projects folder) when path is omitted",
    ),
  name: z
    .string()
    .min(1)
    .max(PROJECT_NAME_MAX_CHARS)
    .optional()
    .describe("Short kebab-case folder name for a create without path (default dir + name)"),
};
export const FORWARD_RESULT_SHAPE = { taskId: TASK_ID, mode: z.enum(["verbatim", "summary"]) };

/** A follow-up the worker asks for next to its result. */
const WORKER_REQUEST = z.preprocess(
  // Models often send a request as a bare string: read it as a question (the object form stays the documented one).
  (v) => (typeof v === "string" ? { kind: "question", text: v } : v),
  z.object({
    kind: z.enum(["question", "capability", "plan"]),
    text: z.string().min(1).max(REQUEST_MAX_CHARS),
  }),
);
/** A doc a developer wrote in its granted location, named for the report (checked and registered by code). */
const ARTIFACT_DOC = z.object({ title: z.string().min(1), path: z.string().min(1) });
export const REPORT_RESULT_SHAPE = {
  title: z
    .string()
    .min(1)
    .describe("Title of the result: it names the result file (no length cap)"),
  status: z.enum(RESULT_KINDS as [string, ...string[]]),
  summary: z.string().min(1).max(REPORT_SUMMARY_MAX_CHARS),
  requests: z.array(WORKER_REQUEST).max(MAX_REQUESTS).optional(),
  artifacts: z
    .array(z.union([z.object({ id: z.string().min(1) }), ARTIFACT_DOC]))
    .max(REPORT_ARTIFACTS_MAX)
    .optional()
    .describe(
      "Artifacts of this result: the id of one you saved, or {title, path} of a doc you wrote in your location (path relative to it)",
    ),
  images: z
    .array(z.string().min(1))
    .max(REPORT_IMAGES_MAX)
    .optional()
    .describe(
      "Screenshots to send to the owner once: absolute paths of png/jpeg/webp files you saved in your scratch dir",
    ),
};

/** A worker's `Report` progress input: how far along (whole percent) and what it is doing now. */
export const REPORT_PROGRESS_SHAPE = {
  percent: z.number().int().min(0).max(100),
  // A cosmetic heartbeat text: a long note is cut to the limit instead of failing the call.
  note: z
    .string()
    .min(1)
    .transform((n) => n.slice(0, PROGRESS_NOTE_MAX_CHARS)),
};

/** Parsed inputs, one per tool. */
export type DispatchInput = z.infer<z.ZodObject<typeof DISPATCH_AGENT_SHAPE>>;
export type TaskStatusInput = z.infer<z.ZodObject<typeof TASK_STATUS_SHAPE>>;
export type SteerInput = z.infer<z.ZodObject<typeof STEER_TASK_SHAPE>>;
export type CancelInput = z.infer<z.ZodObject<typeof CANCEL_TASK_SHAPE>>;
export type RetryInput = z.infer<z.ZodObject<typeof RETRY_TASK_SHAPE>>;
export type AskOwnerInput = z.infer<z.ZodObject<typeof ASK_OWNER_SHAPE>>;
export type RegisterLocationInput = z.infer<z.ZodObject<typeof REGISTER_LOCATION_SHAPE>>;
export type ForwardInput = z.infer<z.ZodObject<typeof FORWARD_RESULT_SHAPE>>;
export type ProgressInput = z.infer<z.ZodObject<typeof REPORT_PROGRESS_SHAPE>>;
export type ReportInput = z.infer<z.ZodObject<typeof REPORT_RESULT_SHAPE>>;
