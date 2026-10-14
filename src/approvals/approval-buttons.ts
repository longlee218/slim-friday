import { ActionRowBuilder, ButtonBuilder, type ButtonStyle } from "discord.js";
import { TYPED_PREFIX } from "../ingress/discord-components";
import { type OwnerLanguage, renderUserNotice } from "../ingress/user-copy";
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
  turnId: string;
  threadId: string;
  /** Resolve with the clicked button value, or undefined on timeout. */
  settle: (value: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Persist the decision and put the task back to running. */
  finish: (decision: ApprovalDecision) => void;
  /** Edit the posted message (drops the buttons). */
  edit: (content: string) => Promise<unknown>;
  content: string;
  /** Option labels in order (a choice shows its label, never its number). */
  labels: string[];
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
