import { ASK_OWNER_TOOL } from "../../mcp/orchestration/tools/AskOwnerTool/constants";
import { CANCEL_TASK_TOOL } from "../../mcp/orchestration/tools/CancelTaskTool/constants";
import { DISPATCH_AGENT_TOOL } from "../../mcp/orchestration/tools/DispatchAgentTool/constants";
import { FORWARD_RESULT_TOOL } from "../../mcp/orchestration/tools/ForwardResultTool/constants";
import { RETRY_TASK_TOOL } from "../../mcp/orchestration/tools/RetryTaskTool/constants";
import { STEER_TASK_TOOL } from "../../mcp/orchestration/tools/SteerTaskTool/constants";
import { TASK_STATUS_TOOL } from "../../mcp/orchestration/tools/TaskStatusTool/constants";
import { isHeld } from "../../storage/owned-item-store";
import type { OwnerQuestion } from "../goal/effect-port";
import { type Reply, refuse } from "../reply";
import { checkDispatch, dispatchQuestion } from "../strategy/dispatch-policy";
import { type LeadToolContext, leadCall } from "./lead-call";
import { OPTIONS_MAX, OPTIONS_MIN } from "./lead-limits";
import type {
  AskOwnerInput,
  CancelInput,
  DispatchInput,
  ForwardInput,
  SteerInput,
  TaskStatusInput,
} from "./lead-schemas";
import { supersedeGate } from "./lead-supersede-gate";

/* The lead's six tool handlers. Pure over the `EffectPort` in the context: they check state, caps and ownership,
   then act through the port. Each call goes through `leadCall` (idempotent, logged, one thread event at least). */

/** Statuses of a task that ended: nothing can steer or cancel it any more. */
export const ENDED = new Set(["completed", "failed", "cancelled"]);
const BAD_TASK = "BAD_TASK";
export const badTask = (id: string): Reply => refuse(BAD_TASK, `Task ${id} is not in this thread.`);

/** DispatchAgent: check the policy, then one port transaction writes goal, items, `start` events and the audit row. */
export const handleDispatch = (ctx: LeadToolContext, input: DispatchInput): Promise<Reply> =>
  leadCall(ctx, DISPATCH_AGENT_TOOL, input, async (key) => {
    const { port } = ctx;
    const caps = { ...port.caps(), dispatchedThisRun: ctx.run.dispatched };
    const check = checkDispatch(port.state(), input, caps, port.env());
    if (!check.ok) return { reply: refuse(check.code, check.message) };
    const blocked = await supersedeGate(ctx, input.supersedes);
    if (blocked) return { reply: blocked };
    // Effect actions the lead declared (push, PR, merge): ONE question to the owner, listing the scope. No = nothing starts.
    const question = dispatchQuestion(input.strategy, check.grants);
    if (question) {
      const a = await port.askOwner({ question, options: ["Yes", "No"] });
      if (a.answer !== "Yes")
        return {
          reply: refuse(
            "OWNER_DENIED",
            "The owner did not allow those actions: dispatch again without them.",
          ),
        };
    }
    const w = port.dispatch({
      key,
      strategy: input.strategy,
      intent: input.intent,
      reason: input.reason,
      ...(input.supersedes && { supersedes: input.supersedes }),
      items: check.items,
      ...(check.grants.length && { grants: check.grants }),
    });
    if (!w.ok) return { reply: refuse(w.code, w.message) };
    ctx.run.dispatched += 1;
    return { reply: { ok: true, goalId: w.goalId, itemIds: w.itemIds }, recorded: true };
  });

/** The status tool: the facts of the goal (or of one task's goal) from the db. A pure read: never cached or recorded. */
export const handleTaskStatus = (ctx: LeadToolContext, input: TaskStatusInput): Promise<Reply> =>
  leadCall(
    ctx,
    TASK_STATUS_TOOL,
    input,
    () => {
      const snap = ctx.port.snapshot(input.taskId);
      return { reply: snap ? { ok: true, ...snap } : badTask(input.taskId ?? "") };
    },
    { read: true },
  );

/** SteerTask: owner text to one task of this thread. */
export const handleSteer = (ctx: LeadToolContext, input: SteerInput): Promise<Reply> =>
  leadCall(ctx, STEER_TASK_TOOL, input, () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    // A held task has no run to take the text and no waiting answer to resume: only RetryTask (with a note) starts it again.
    if (isHeld(item))
      return {
        reply: refuse(
          "HELD",
          `Task is held: use ${RETRY_TASK_TOOL} with the text as its note (it resumes the task), or cancel it.`,
        ),
      };
    const result = ctx.port.steer(input.taskId, input.text);
    return {
      reply: { ok: true, result },
      itemId: item.id,
      events: [
        { kind: "steer", taskId: item.parentId ?? item.id, itemId: item.id, payload: { result } },
      ],
    };
  });

/** CancelTask: cancel one task and its dependents; a task that already ended is refused. */
export const handleCancel = (ctx: LeadToolContext, input: CancelInput): Promise<Reply> =>
  leadCall(ctx, CANCEL_TASK_TOOL, input, () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    if (ENDED.has(item.status)) return { reply: refuse("ENDED", `Task already ${item.status}.`) };
    const cancelled = ctx.port.cancel(input.taskId, input.reason);
    return {
      reply: { ok: true, cancelled },
      itemId: item.id,
      events: [
        {
          kind: "cancel",
          taskId: item.parentId ?? item.id,
          itemId: item.id,
          payload: { reason: input.reason, cancelled },
        },
      ],
    };
  });

/** Options of a `yesno` question: canonical values (the buttons are localized at the Discord edge). */
const YES_NO = ["Yes", "No"];

/** Map a typed `AskOwner` input to the port question; a string is the refusal message (options do not fit the kind). */
export function askQuestion(input: AskOwnerInput): OwnerQuestion | string {
  const { kind, question, taskId, workerAskId } = input;
  const given = input.options ?? [];
  if (kind === "select") {
    if (given.length < OPTIONS_MIN || given.length > OPTIONS_MAX)
      return `select needs ${OPTIONS_MIN}-${OPTIONS_MAX} options.`;
    return { question, options: given, taskId, workerAskId };
  }
  if (given.length) return `${kind} takes no options.`;
  return {
    question,
    options: kind === "yesno" ? YES_NO : [],
    yesno: kind === "yesno",
    taskId,
    workerAskId,
  };
}

/** AskOwner: a yes/no, select or typed question; the reply carries the answer, or the code TIMEOUT. */
export const handleAskOwner = (ctx: LeadToolContext, input: AskOwnerInput): Promise<Reply> =>
  leadCall(ctx, ASK_OWNER_TOOL, input, async () => {
    if (input.taskId && !ctx.port.item(input.taskId)) return { reply: badTask(input.taskId) };
    const q = askQuestion(input);
    if (typeof q === "string") return { reply: refuse("BAD_OPTIONS", q) };
    const a = await ctx.port.askOwner(q);
    const payload = { question: input.question, answered: !a.timedOut };
    const events = [{ kind: "question" as const, payload }];
    if (a.timedOut || a.answer === undefined)
      return { reply: refuse("TIMEOUT", "The owner did not answer in time."), events };
    return { reply: { ok: true, answer: a.answer }, events };
  });

/**
 * ForwardResult: post a finished item's result file(s) (verbatim) or its excerpt (summary). Verbatim posts one message
 * per file the task saved, the primary (result path) first; each file gets its own Open link.
 */
export const handleForward = (ctx: LeadToolContext, input: ForwardInput): Promise<Reply> =>
  leadCall(ctx, FORWARD_RESULT_TOOL, input, async () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    const verbatim = input.mode === "verbatim";
    if (verbatim ? !item.resultPath : !item.resultExcerpt)
      return { reply: refuse("NO_RESULT", "The task has no result yet.") };
    if (!verbatim) {
      await ctx.port.post({ text: item.resultExcerpt as string });
      return { reply: { ok: true, posted: input.mode }, itemId: item.id };
    }
    const files = [...new Set([item.resultPath as string, ...ctx.port.resultFiles(input.taskId)])];
    for (const filePath of files) await ctx.port.post({ filePath });
    return { reply: { ok: true, posted: input.mode, files: files.length }, itemId: item.id };
  });
