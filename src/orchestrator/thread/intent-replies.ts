import type { AskReason } from "../../intent/decide-intent";
import { ROLES } from "../../roles/role-registry";

/** Why the owner is asked: the intent reasons, plus a `max` effort that needs a confirmation chat cannot give yet. */
export type AskKind = AskReason | "max_effort";

/** Role tags (`[ask]`, `[dev]`) from the registry: the owner's way to force a role. */
const tags = (): string =>
  Object.values(ROLES)
    .map((r) => r.aliases?.tag)
    .filter(Boolean)
    .join(" or ");

/** The ONE question of each ask reason. */
export const ASK_TEXT: Record<AskKind, () => string> = {
  low_confidence: () =>
    `Not sure what you want. Start your message with ${tags()} and send it again.`,
  unknown_role: () =>
    `I could not match that to a role. Start your message with ${tags()} and send it again.`,
  unclassified: () =>
    `Could not classify that. Send it again starting with ${tags()}, or \`stop\`.`,
  max_effort: () =>
    "That asks for max effort (Opus, costly) and needs your OK, which chat cannot give yet. Send it again without it to run at high.",
};

/** Reply while the thread's run holds the lock. */
export const STILL_WORKING = "still working...";
/** A text yes/no (or feedback) while a button gate waits. */
export const GATE_HINT = "Use the Approve / Reject buttons on the message above.";
export const NOTHING_PENDING = "Nothing is waiting for an answer.";
/** A staged task cannot start without the approval flow (same text as the legacy refusal). */
export const NO_APPROVALS = "Code tasks need the Discord approval flow.";
