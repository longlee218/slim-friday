import { type OwnerLanguage, renderUserNotice } from "../../../ingress/user-copy";
import { clip, redactText } from "../../../observability/redact";
import type { ApprovalResult } from "../../../owner-approval/approval-types";
import type { ApprovalDecision } from "../../../storage/approval-store";
import type { Intent } from "../ui/components/buttons";
import { TYPED_PREFIX } from "../ui/components/choice";
import type { Tone } from "../ui/components/tone";

/** A request waiting for a click. */
export interface Pending {
  turnId: string;
  threadId: string;
  /** Resolve with the clicked button value, or undefined on timeout. */
  settle: (value: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Persist the decision and put the task back to running. */
  finish: (decision: ApprovalDecision) => void;
  /** Edit the posted message (drops the buttons); `tone` colors the container (green chosen, red denied, grey cancelled). */
  edit: (content: string, tone: Tone) => Promise<unknown>;
  content: string;
  /** Name of the file attached to the message; it stays visible after the edit. */
  fileName?: string | undefined;
  /** Option labels in order (a choice shows its label, never its number). */
  labels: string[];
  /** Intent of each option button in the same order (a reject settles red); empty = all plain choices. */
  intents: Intent[];
  /** Conversation language of the thread, fixed when the question was posted. */
  language: OwnerLanguage;
}

/** Longest typed answer echoed back in the settled message. */
const ECHO_MAX = 300;

/** Drop every open request of a task (run aborted): timers cleared, decision "cancelled", buttons removed. */
export function cancelPending(pending: Map<string, Pending>, taskId: string): void {
  for (const [id, p] of pending) {
    if (p.turnId !== taskId) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.finish("cancelled");
    void p.edit(
      `${p.content}\n\n${renderUserNotice({ kind: "approval", state: "cancelled" }, p.language)}`,
      "info",
    );
    p.settle("cancelled");
  }
}

/** The line shown once the owner answered: the chosen label or the typed words (redacted), never an index. */
export function settledLine(p: Pending, prefix: string, value: string): string {
  const say = (state: "chose" | "answered", text: string) =>
    renderUserNotice({ kind: "choice", state, text }, p.language);
  if (value.startsWith(TYPED_PREFIX))
    return say("answered", clip(redactText(value.slice(TYPED_PREFIX.length)), ECHO_MAX));
  // An approval prompt maps its two values to its two labels; a question's value is the option index.
  const index = prefix === "appr" ? (value === "allow" ? 0 : 1) : Number(value);
  return say("chose", p.labels[index] ?? "");
}

/** Apply an answer to its open request (timer cleared, decision stored, waiter resolved). */
export function settleClick(p: Pending, prefix: string, value: string): void {
  clearTimeout(p.timer);
  const approved = prefix === "choice" || value === "allow";
  p.finish(approved ? "approved" : "denied");
  p.settle(value);
}

/** Map the clicked value of an approve/deny prompt to a result. */
export function toResult(value: string | undefined, denyReason: string): ApprovalResult {
  if (value === "allow") return { approved: true };
  if (value === undefined) return { approved: false, reason: "timeout" };
  if (value === "cancelled") return { approved: false, reason: "cancelled" };
  if (value === "no-channel") return { approved: false, reason: "no channel" };
  return { approved: false, reason: denyReason };
}
