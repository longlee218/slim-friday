import {
  ASK_OWNER_TOOL,
  CANCEL_TASK_TOOL,
  DISPATCH_AGENT_TOOL,
  FORWARD_RESULT_TOOL,
  REQUEST_ESCALATION_TOOL,
  STEER_TASK_TOOL,
  TASK_STATUS_TOOL,
} from "../../mcp/mcp-tool-names";
import { checkDispatch } from "../strategy/dispatch-policy";
import { type LeadToolContext, leadCall, type Reply, refuse } from "./lead-call";
import type {
  AskOwnerInput,
  CancelInput,
  DispatchInput,
  EscalationInput,
  ForwardInput,
  SteerInput,
  TaskStatusInput,
} from "./lead-schemas";

/* The lead's seven tool handlers. Pure over the `EffectPort` in the context: they check state, caps and ownership,
   then act through the port. Each call goes through `leadCall` (idempotent, logged, one thread event at least). */

/** Statuses of a task that ended: nothing can steer or cancel it any more. */
const ENDED = new Set(["completed", "failed", "cancelled"]);
const BAD_TASK = "BAD_TASK";
const badTask = (id: string): Reply => refuse(BAD_TASK, `Task ${id} is not in this thread.`);

/** DispatchAgent: check the policy, then one port transaction writes goal, items, `start` events and the audit row. */
export const handleDispatch = (ctx: LeadToolContext, input: DispatchInput): Promise<Reply> =>
  leadCall(ctx, DISPATCH_AGENT_TOOL, input, (key) => {
    const { port } = ctx;
    const caps = { ...port.caps(), dispatchedThisRun: ctx.run.dispatched };
    const check = checkDispatch(port.state(), input, caps, port.env());
    if (!check.ok) return { reply: refuse(check.code, check.message) };
    const w = port.dispatch({
      key,
      strategy: input.strategy,
      intent: input.intent,
      reason: input.reason,
      ...(input.supersedes && { supersedes: input.supersedes }),
      items: check.items,
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

/** AskOwner: button question; the reply carries the answer, or the code TIMEOUT. */
export const handleAskOwner = (ctx: LeadToolContext, input: AskOwnerInput): Promise<Reply> =>
  leadCall(ctx, ASK_OWNER_TOOL, input, async () => {
    if (input.taskId && !ctx.port.item(input.taskId)) return { reply: badTask(input.taskId) };
    const a = await ctx.port.askOwner(input);
    const payload = { question: input.question, answered: !a.timedOut };
    const events = [{ kind: "question" as const, payload }];
    if (a.timedOut || a.answer === undefined)
      return { reply: refuse("TIMEOUT", "The owner did not answer in time."), events };
    return { reply: { ok: true, answer: a.answer }, events };
  });

/** ForwardResult: post a finished item's result file (verbatim) or its excerpt (summary). */
export const handleForward = (ctx: LeadToolContext, input: ForwardInput): Promise<Reply> =>
  leadCall(ctx, FORWARD_RESULT_TOOL, input, async () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    const verbatim = input.mode === "verbatim";
    if (verbatim ? !item.resultPath : !item.resultExcerpt)
      return { reply: refuse("NO_RESULT", "The task has no result yet.") };
    await ctx.port.post(
      verbatim ? { filePath: item.resultPath as string } : { text: item.resultExcerpt as string },
    );
    return { reply: { ok: true, posted: input.mode }, itemId: item.id };
  });

/** RequestEscalation: one stronger-tier re-run of this input; a second ask in the run is refused. */
export const handleEscalation = (ctx: LeadToolContext, input: EscalationInput): Promise<Reply> =>
  leadCall(ctx, REQUEST_ESCALATION_TOOL, input, () => {
    const granted = ctx.port.requestEscalation(input.to, input.reason);
    return {
      reply: granted
        ? { ok: true, to: input.to }
        : refuse("ESCALATION_USED", "An escalation was already requested in this run."),
      events: [{ kind: "lead_decision", payload: { to: input.to, reason: input.reason, granted } }],
    };
  });
