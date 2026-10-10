import { ActionRowBuilder, ButtonBuilder, type ButtonStyle } from "discord.js";
import { clip, redactText } from "../observability/redact";
import type { ApprovalDecision } from "../storage/approval-store";
import type { ApprovalResult } from "./approval-types";

/** Discord limits: 5 buttons per row, 80 chars per label. */
const ROW_SIZE = 5;
const LABEL_MAX = 80;

/** One button: `value` is what the pending request resolves with. */
export interface ButtonSpec {
  label: string;
  value: string;
  style: ButtonStyle;
}

/** Lay buttons out in rows; customId = `${prefix}:${id}:${value}`. */
export function buildButtonRows(
  prefix: string,
  id: string,
  buttons: ButtonSpec[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += ROW_SIZE) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons
          .slice(i, i + ROW_SIZE)
          .map((b) =>
            new ButtonBuilder()
              .setCustomId(`${prefix}:${id}:${b.value}`)
              .setLabel(clip(b.label, LABEL_MAX))
              .setStyle(b.style),
          ),
      ),
    );
  }
  return rows;
}

/** A request waiting for a click. */
export interface Pending {
  taskId: string;
  threadId: string;
  /** The tool the request is for (the plan gate is the one typed feedback can answer). */
  tool: string;
  /** Resolve with the clicked button value, or undefined on timeout. */
  settle: (value: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Persist the decision and put the task back to running. */
  finish: (decision: ApprovalDecision) => void;
  /** Edit the posted message (drops the buttons). */
  edit: (content: string) => Promise<unknown>;
  content: string;
}

/** Drop every open request of a task (run aborted): timers cleared, decision "cancelled", buttons removed. */
export function cancelPending(pending: Map<string, Pending>, taskId: string): void {
  for (const [id, p] of pending) {
    if (p.taskId !== taskId) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.finish("cancelled");
    void p.edit(`${p.content}\n\nCancelled`);
    p.settle("cancelled");
  }
}

/** Apply a button click to its open request (timer cleared, decision stored, waiter resolved); returns the label shown. */
export function settleClick(p: Pending, prefix: string, value: string): string {
  clearTimeout(p.timer);
  const approved = prefix === "choice" || value === "allow";
  p.finish(approved ? "approved" : "denied");
  p.settle(value);
  return prefix === "choice" ? `chose #${Number(value) + 1}` : approved ? "approved" : "denied";
}

/** Settle value of a request answered with typed text instead of a click (never a button value). */
const FEEDBACK_PREFIX = "feedback:";

/** Longest typed feedback handed to the model as the reject reason (chars). */
const FEEDBACK_MAX = 1000;

/**
 * Typed feedback on the open plan request of `threadId` = the Reject button with the owner's words as the reason:
 * the buttons are dropped, the planner revises and asks again (new buttons). False when no such request waits.
 */
export function settleWithFeedback(
  pending: Map<string, Pending>,
  threadId: string,
  tool: string,
  text: string,
): boolean {
  for (const [id, p] of pending) {
    if (p.threadId !== threadId || p.tool !== tool) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.finish("denied");
    void p.edit(`${p.content}\n\nOwner sent feedback`);
    p.settle(`${FEEDBACK_PREFIX}${text}`);
    return true;
  }
  return false;
}

/** Map the clicked value of an approve/deny prompt to a result. */
export function toResult(value: string | undefined, denyReason: string): ApprovalResult {
  if (value?.startsWith(FEEDBACK_PREFIX))
    return {
      approved: false,
      reason: clip(redactText(value.slice(FEEDBACK_PREFIX.length)), FEEDBACK_MAX),
    };
  if (value === "allow") return { approved: true };
  if (value === undefined) return { approved: false, reason: "timeout" };
  if (value === "cancelled") return { approved: false, reason: "cancelled" };
  if (value === "no-channel") return { approved: false, reason: "no channel" };
  return { approved: false, reason: denyReason };
}
