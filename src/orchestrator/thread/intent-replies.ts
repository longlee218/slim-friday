import type { AskReason } from "../../intent/decide-intent";
import { leadingRoleTag } from "../../intent/role-tag";
import { redactText } from "../../observability/redact";
import { ROLES } from "../../roles/role-registry";

/** Why the owner is asked (the intent reasons; a `max` effort is confirmed with buttons, see max-effort-gate.ts). */
export type AskKind = AskReason;

/** Drop the leading role tag (`[dev]`, `[ask]`) the owner typed: it routed the message, it is not part of the brief. */
export function stripRoleTag(text: string): string {
  const hit = leadingRoleTag(text, Object.values(ROLES));
  return hit?.rest || text;
}

/**
 * The ONE question of each ask reason when the model wrote none: neutral, no tag or command instructions (the
 * owner just says it again, more clearly). A model-written `ask` (owner's language) takes its place.
 */
export const ASK_TEXT: Record<AskKind, () => string> = {
  low_confidence: () => "I am not sure what you want. Could you say it a bit more specifically?",
  unknown_role: () => "I could not tell what you want. Could you rephrase it?",
  unclassified: () => "I could not tell what you want. Could you send it again?",
  pending_unclear: () =>
    "I could not tell if that answers my question above. Answer it again, or send `/go` to start it, or `/stop` to drop it.",
};

/** Reply while the thread's run holds the lock. */
export const STILL_WORKING = "still working...";
/** A text yes/no (or feedback) while a button gate waits. */
export const GATE_HINT = "Use the Approve / Reject buttons on the message above.";
export const NOTHING_PENDING = "Nothing is waiting for an answer.";
/** A staged task cannot start without the approval flow (same text as the legacy refusal). */
export const NO_APPROVALS = "This task needs the Discord approval flow.";
/** A steer reached the run's input. It says "received", never that the agent read it: the model takes it at its next turn boundary, after the current tools. */
export const STEER_RECEIVED = "received, the agent takes it at its next step";
/** A steer arrived while a tool approval waits: the message is stored and reaches the agent after the owner decides. Never says "read". */
export const STEER_WAITING = (tool: string) =>
  `agent is waiting for your approval of ${redactText(tool)} above (Approve/Deny); your message is saved and is delivered after the decision`;
/** A steer arrived while the run is between two streaming stages: it goes into the next one. */
export const STEER_HELD = "received, the agent takes it when its next stage starts";
/** Typed feedback was handed to the plan gate: the planner revises and posts the plan again with new buttons. */
export const FEEDBACK_SENT =
  "received, the plan is being revised with your feedback; approve the new plan when it is posted";
/** The plan was decided between the decision and the feedback (nothing waits for it any more). */
export const FEEDBACK_MISSED =
  "The plan was just decided, so the feedback was not applied. Send it again.";
/** The global run limit is full: a side question cannot get its own run right now. */
export const SIDE_BUSY = (active: number) => `busy, ${active} runs active, try again in a minute`;
/** The run already has the max pending steers (`MAX_PENDING_STEERS`). */
export const STEER_FULL = "too many pending, wait or send `/stop`";
/** The run ended between the decision and the push (nothing can take the message any more). */
export const STEER_ENDED = "That run just ended, so the message was not delivered. Send it again.";
/** An independent message of any role was queued: it runs when the current task ends (no question asked). */
export const QUEUE_RECEIVED = "received, it runs after the current task";
/** The thread already holds the max queued follow-ups (`MAX_QUEUED`): nothing is accepted silently. */
export const QUEUE_FULL = "too many queued after the current task, wait for it or send `/stop`";
/** Head of the notice listing steers the run ended without reading (the messages follow, one per line). */
export const NOT_DELIVERED =
  "Not delivered to the agent (it ended or timed out first), send again:";
