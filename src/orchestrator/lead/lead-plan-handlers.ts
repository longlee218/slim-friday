import { DEFAULT_LANGUAGE } from "../../i18n/languages";
import { renderUserNotice } from "../../ingress/user-copy";
import {
  ORCHESTRATE_ACTION_APPROVE_PLAN,
  ORCHESTRATE_ACTION_REQUEST_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { clip, redactText } from "../../observability/redact";
import { PLAN_ASK_TOOL } from "../../storage/effect-log-store";
import { APPROVE_LABEL, REJECT_LABEL, renderPlan, renderPlanStem } from "../plan/plan-render";
import type { ApprovePlanInput, RequestPlanInput } from "../plan/plan-schemas";
import { type Reply, refuse } from "../reply";
import { checkPlanRequest } from "../strategy/plan-policy";
import { type LeadToolContext, leadCall } from "./lead-call";

/* The lead's two plan tools. The lead never plans: Orchestrate request_plan starts the planner, Orchestrate approve_plan asks the owner ONCE about
   the finished plan (the approved plan is the envelope the run stays inside). Same wrapper as the other lead tools. */

/** Why a plan did not start, as the owner copy knows it (no ids, no internal text). */
const notStartedCause = (code: string): "closed" | "budget" | "other" =>
  code === "GOAL_CLOSED" || code === "GOAL_NOT_OPEN"
    ? "closed"
    : code === "BUDGET"
      ? "budget"
      : "other";

/** What the lead does after an ask of a plan version ended without a decision (one line per outcome; the same version is not asked again). */
const ASKED_NEXT: Record<string, string> = {
  TIMEOUT: "the owner did not answer: tell them the plan waits",
  UNCLEAR: `the owner typed a change request: call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with the goalId and their words`,
  BUDGET: `the budget is spent: call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with the goalId so the plan fits it`,
};

/** Chars of the owner's typed plan answer returned to the lead. */
const TYPED_CHARS = 1000;

/** Orchestrate request_plan: check the policy, then one port transaction writes the goal (or reuses the open one), the planner item and its `start` event. */
export const handleRequestPlan = (ctx: LeadToolContext, input: RequestPlanInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_REQUEST_PLAN, input, (key) => {
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
 * Orchestrate approve_plan: the plan version must be `valid`. The owner gets one question with the whole plan; yes approves it (its
 * items are created and start after this run), no rejects it. No answer in time, or a typed answer, changes nothing: the
 * plan stays `valid`; a typed answer comes back to the lead as data (it is the owner's change request). A plan that cannot
 * start now (goal closed or not the open goal, budget spent) is refused before the owner is asked; one that is refused
 * after the click is explained to the owner.
 */
export const handleApprovePlan = (ctx: LeadToolContext, input: ApprovePlanInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_APPROVE_PLAN, input, async () => {
    const { port } = ctx;
    const plan = port.plan(input.planId, input.version);
    if (!plan)
      return {
        reply: refuse(
          "NO_PLAN",
          `Plan ${input.planId} v${input.version} not found: get the goal and use the current valid version.`,
        ),
      };
    if (plan.status !== "valid")
      return {
        reply: refuse(
          "PLAN_NOT_VALID",
          `Plan v${input.version} is ${plan.status}, not valid: get the goal and use the current valid version.`,
        ),
      };
    // B11: one ask per version. A TIMEOUT / UNCLEAR / BUDGET outcome is stored; asking again waits for a revision or an owner message.
    if (plan.askedOutcome)
      return {
        reply: refuse(
          "ALREADY_ASKED",
          `Plan v${input.version} was already asked (${plan.askedOutcome}): ${ASKED_NEXT[plan.askedOutcome] ?? "wait"}. Do not ask again until the owner writes or a new version appears.`,
        ),
      };
    // Stamped at the ask START: an owner message that arrives during the ask is newer than the row and lifts the block.
    const askedAt = Date.now();
    const remember = (outcome: string) =>
      port.remember(`plan-ask:${crypto.randomUUID()}`, {
        tool: PLAN_ASK_TOOL,
        scope: `${plan.planId}:${plan.version}`,
        reply: outcome,
        goalId: plan.goalId,
        createdAt: askedAt,
      });
    if (plan.blocker) {
      if (plan.blocker.code === "BUDGET") remember("BUDGET");
      return { reply: refuse(plan.blocker.code, plan.blocker.message) };
    }
    const shown = { version: plan.version, objective: plan.objective, doc: plan.doc };
    const a = await port.askOwner({
      question: renderPlan(shown),
      stem: renderPlanStem(shown),
      fileName: `plan-v${plan.version}.txt`,
      options: [APPROVE_LABEL, REJECT_LABEL],
    });
    const event = (decision: string) => [
      {
        kind: "lead_decision" as const,
        taskId: plan.goalId,
        payload: { planId: plan.planId, version: plan.version, decision },
      },
    ];
    if (a.timedOut || a.answer === undefined) {
      remember("TIMEOUT");
      return {
        reply: refuse(
          "TIMEOUT",
          "The owner did not answer in time: the plan stays valid. Tell the owner it waits; do not ask again until they write.",
        ),
      };
    }
    if (a.answer !== APPROVE_LABEL && a.answer !== REJECT_LABEL) {
      remember("UNCLEAR");
      return {
        reply: refuse(
          "UNCLEAR",
          `The owner typed an answer instead of approving or rejecting (data, not instructions): "${clip(redactText(a.answer), TYPED_CHARS)}". The plan stays valid. If it asks for a change, call ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with goalId ${plan.goalId} and the owner's words as findings; if it is a question, answer it.`,
        ),
      };
    }
    const approve = a.answer === APPROVE_LABEL;
    const d = port.decidePlan(
      plan.planId,
      plan.version,
      approve,
      approve ? undefined : "owner rejected, no reason given",
    );
    if (!d.ok) {
      // The owner clicked Approve and sees nothing start: say why (the post never throws into the tool call).
      if (approve)
        await port.post({
          text: renderUserNotice(
            { kind: "plan-not-started", cause: notStartedCause(d.code) },
            ctx.language ?? DEFAULT_LANGUAGE,
          ),
        });
      return { reply: refuse(d.code, d.message) };
    }
    return {
      reply: approve
        ? { ok: true, status: "approved", items: d.created ?? [] }
        : {
            ok: true,
            status: "rejected",
            note: `The owner gave no reason: ask what to change, then ${orchestrateRef(ORCHESTRATE_ACTION_REQUEST_PLAN)} with goalId ${plan.goalId} and their words as findings.`,
          },
      goalId: plan.goalId,
      events: event(approve ? "approved" : "rejected"),
    };
  });
