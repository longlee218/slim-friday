import { ActionRowBuilder, ButtonBuilder, type ButtonStyle } from "discord.js";
import { clip } from "../observability/redact";
import type { ApprovalDecision } from "../storage/run-store";
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
  /** Resolve with the clicked button value, or undefined on timeout. */
  settle: (value: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Persist the decision and put the task back to running. */
  finish: (decision: ApprovalDecision) => void;
  /** Edit the posted message (drops the buttons). */
  edit: (content: string) => Promise<unknown>;
  content: string;
}

/** Map the clicked value of an approve/deny prompt to a result. */
export function toResult(value: string | undefined, denyReason: string): ApprovalResult {
  if (value === "allow") return { approved: true };
  if (value === undefined) return { approved: false, reason: "timeout" };
  if (value === "cancelled") return { approved: false, reason: "cancelled" };
  if (value === "no-channel") return { approved: false, reason: "no channel" };
  return { approved: false, reason: denyReason };
}
