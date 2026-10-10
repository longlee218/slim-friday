import type { AskReason } from "../../intent/decide-intent";
import { leadingRoleTag } from "../../intent/role-tag";
import { ROLES } from "../../roles/role-registry";

/** Why the owner is asked: the intent reasons, plus a `max` effort that needs a confirmation chat cannot give yet. */
export type AskKind = AskReason | "max_effort";

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
  max_effort: () =>
    "That asks for max effort (Opus, costly) and needs your OK, which chat cannot give yet. Send it again without it to run at high.",
};

/** Reply while the thread's run holds the lock. */
export const STILL_WORKING = "still working...";
/** A text yes/no (or feedback) while a button gate waits. */
export const GATE_HINT = "Use the Approve / Reject buttons on the message above.";
export const NOTHING_PENDING = "Nothing is waiting for an answer.";
/** A staged task cannot start without the approval flow (same text as the legacy refusal). */
export const NO_APPROVALS = "This task needs the Discord approval flow.";
/** Prepended to an assistant answer when a dev task cannot start for lack of a workspace clone (until the per-task clone lands). */
export const NO_CLONE_NOTICE =
  "Note: dev tasks need a workspace clone of the repo, which is not set up yet, so I answer this as a conversation instead.";
