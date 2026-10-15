import { APPROVE_PLAN_TOOL, REQUEST_PLAN_TOOL } from "../../mcp/mcp-tool-names";
import { APPROVE_LABEL, REJECT_LABEL, renderPlan } from "../plan/plan-render";
import type { ApprovePlanInput, RequestPlanInput } from "../plan/plan-schemas";
import { checkPlanRequest } from "../strategy/plan-policy";
import { type LeadToolContext, leadCall, type Reply, refuse } from "./lead-call";

/* The lead's two plan tools. The lead never plans: RequestPlan starts the planner, ApprovePlan asks the owner ONCE about
   the finished plan (the approved plan is the envelope the run stays inside). Same wrapper as the other lead tools. */

/** RequestPlan: check the policy, then one port transaction writes the goal (or reuses the open one), the planner item and its `start` event. */
export const handleRequestPlan = (ctx: LeadToolContext, input: RequestPlanInput): Promise<Reply> =>
  leadCall(ctx, REQUEST_PLAN_TOOL, input, (key) => {
    const { port } = ctx;
    const check = checkPlanRequest(port.state(), input, {
      ...port.caps(),
      dispatchedThisRun: ctx.run.dispatched,
    });
    if (!check.ok) return { reply: refuse(check.code, check.message) };
    const w = port.requestPlan({ key, ...input });
    if (!w.ok) return { reply: refuse(w.code, w.message) };
    ctx.run.dispatched += 1;
    return { reply: { ok: true, goalId: w.goalId, itemIds: w.itemIds }, recorded: true };
  });

/**
 * ApprovePlan: the plan version must be `valid`. The owner gets one question with the whole plan; yes approves it (its
 * items are created and start after this run), no rejects it. No answer in time, or an unclear typed answer, changes
 * nothing: the plan stays `valid` and the lead may ask again.
 */
export const handleApprovePlan = (ctx: LeadToolContext, input: ApprovePlanInput): Promise<Reply> =>
  leadCall(ctx, APPROVE_PLAN_TOOL, input, async () => {
    const { port } = ctx;
    const plan = port.plan(input.planId, input.version);
    if (!plan)
      return { reply: refuse("NO_PLAN", `Plan ${input.planId} v${input.version} not found.`) };
    if (plan.status !== "valid")
      return {
        reply: refuse("PLAN_NOT_VALID", `Plan v${input.version} is ${plan.status}, not valid.`),
      };
    const a = await port.askOwner({
      question: renderPlan({ version: plan.version, objective: plan.objective, doc: plan.doc }),
      options: [APPROVE_LABEL, REJECT_LABEL],
    });
    const event = (decision: string) => [
      {
        kind: "lead_decision" as const,
        taskId: plan.goalId,
        payload: { planId: plan.planId, version: plan.version, decision },
      },
    ];
    if (a.timedOut || a.answer === undefined)
      return {
        reply: refuse("TIMEOUT", "The owner did not answer in time: the plan stays valid."),
      };
    if (a.answer !== APPROVE_LABEL && a.answer !== REJECT_LABEL)
      return {
        reply: refuse(
          "UNCLEAR",
          "The answer was neither approve nor reject: the plan stays valid.",
        ),
      };
    const approve = a.answer === APPROVE_LABEL;
    const d = port.decidePlan(
      plan.planId,
      plan.version,
      approve,
      approve ? undefined : "owner rejected",
    );
    if (!d.ok) return { reply: refuse(d.code, d.message) };
    return {
      reply: approve
        ? { ok: true, status: "approved", items: d.created ?? [] }
        : { ok: true, status: "rejected" },
      goalId: plan.goalId,
      events: event(approve ? "approved" : "rejected"),
    };
  });
