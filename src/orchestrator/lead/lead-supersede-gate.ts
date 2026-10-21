import { DEFAULT_LANGUAGE } from "../../i18n/languages";
import { renderUserNotice } from "../../ingress/user-copy";
import { clip, redactText } from "../../observability/redact";
import { type Reply, refuse } from "../reply";
import type { LeadToolContext } from "./lead-call";

/** Chars of the goal's intent shown in the owner question. */
const INTENT_CHARS = 120;

/**
 * Replacing a PLAN goal cancels the owner-approved plan: the owner decides, not a tool argument (B2). That is the open
 * PLAN goal named by `supersedes` and a wave-held one (capped / stalled), which a new goal closes as well. Returns a
 * refusal (No, or no answer in time: a distinct code) or undefined when the dispatch may go on.
 */
export async function supersedeGate(
  ctx: LeadToolContext,
  supersedes: string | undefined,
): Promise<Reply | undefined> {
  const { port } = ctx;
  const state = port.state();
  const planGoalId =
    supersedes && state.structureOwner === "planner" ? supersedes : state.waveHeldGoalId;
  if (!planGoalId) return undefined;
  const intent = port.snapshot(planGoalId)?.intent;
  const a = await port.askOwner({
    question: renderUserNotice(
      {
        kind: "plan-supersede-ask",
        ...(intent && { intent: clip(redactText(intent), INTENT_CHARS) }),
      },
      ctx.language ?? DEFAULT_LANGUAGE,
    ),
    options: ["Yes", "No"],
    yesno: true,
  });
  if (a.timedOut || a.answer === undefined)
    return refuse(
      "OWNER_TIMEOUT",
      "The owner did not answer in time: the plan goal stays. Ask again only after they write.",
    );
  if (a.answer !== "Yes")
    return refuse(
      "OWNER_DENIED",
      "The owner did not allow replacing the plan goal: wait for it, re-plan it, or cancel its tasks.",
    );
  return undefined;
}
