import { renderUserNotice } from "../../ingress/user-copy";
import type { AskReason } from "../../intent/decide-intent";
import { leadingRoleTag } from "../../intent/role-tag";
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
  low_confidence: () => renderUserNotice({ kind: "clarification" }, "en"),
  unknown_role: () => renderUserNotice({ kind: "clarification" }, "en"),
  unclassified: () => renderUserNotice({ kind: "clarification" }, "en"),
  pending_unclear: () => renderUserNotice({ kind: "clarification", pending: true }, "en"),
};
export const STILL_WORKING = renderUserNotice({ kind: "failure", cause: "busy" }, "en");
export const GATE_HINT = renderUserNotice({ kind: "decision", state: "gate" }, "en");
export const NOTHING_PENDING = renderUserNotice({ kind: "decision", state: "none" }, "en");
export const NO_APPROVALS = renderUserNotice({ kind: "failure", cause: "approval" }, "en");
export const STEER_RECEIVED = renderUserNotice({ kind: "steer", state: "queued" }, "en");
export const STEER_WAITING = (_tool: string) =>
  renderUserNotice({ kind: "steer", state: "waiting" }, "en");
export const STEER_HELD = renderUserNotice({ kind: "steer", state: "held" }, "en");
export const SIDE_BUSY = (_active: number) => STILL_WORKING;
export const STEER_FULL = renderUserNotice({ kind: "steer", state: "full" }, "en");
export const STEER_ENDED = renderUserNotice({ kind: "steer", state: "ended" }, "en");
export const QUEUE_RECEIVED = renderUserNotice({ kind: "queue" }, "en");
export const QUEUE_FULL = renderUserNotice({ kind: "queue", full: true }, "en");
export const NOT_DELIVERED = renderUserNotice({ kind: "decision", state: "undelivered" }, "en");
