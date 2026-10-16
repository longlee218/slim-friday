import type { Database } from "bun:sqlite";
import { type Interaction, MessageFlags } from "discord.js";
import type { Logger } from "pino";
import {
  ANSWER_FIELD,
  buildAnswerModal,
  CHOICE_PREFIX,
  ENTER_VALUE,
  TYPED_PREFIX,
  threadLanguage,
} from "../ingress/discord-components";
import { type OwnerLanguage, renderUserNotice } from "../ingress/user-copy";
import { errText } from "../observability/redact";
import { type Pending, settleClick, settledLine } from "./approval-buttons";

/** What the interaction handler needs from the gateway. */
export interface InteractionCtx {
  db: Database;
  ownerId: string;
  /** Open requests by approval id (shared with the gateway). */
  pending: Map<string, Pending>;
  log: Logger;
}

/** Reply only the owner sees (wrong user, expired request). */
const whisper = (
  i: { reply: (o: { content: string; flags: MessageFlags.Ephemeral }) => Promise<unknown> },
  state: "owner-only" | "expired",
  language: OwnerLanguage,
) =>
  i.reply({
    content: renderUserNotice({ kind: "approval", state }, language),
    flags: MessageFlags.Ephemeral,
  });

/** Handle a button, select menu or modal click on an approval or question message (owner only). */
export async function handleApprovalInteraction(
  i: Interaction,
  ctx: InteractionCtx,
): Promise<void> {
  const { db, ownerId, pending, log } = ctx;
  try {
    // Short-circuit order: a button never asks the other type guards.
    if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return;
    const isModal = !i.isButton() && !i.isStringSelectMenu();
    const [prefix, id, value] = i.customId.split(":");
    if ((prefix !== "appr" && prefix !== CHOICE_PREFIX) || !id || value === undefined) return;
    // Approve/deny stay explicit buttons; selects and modals belong to questions only.
    if (prefix === "appr" && !i.isButton()) return;
    const language = threadLanguage(db, i.channelId ?? "");
    // Validate owner and pending id before anything mutates.
    if (i.user.id !== ownerId) return void (await whisper(i, "owner-only", language));
    const p = pending.get(id);
    if (!p) return void (await whisper(i, "expired", language));

    // "Enter answer": the modal is the response (it must open within Discord's deadline); nothing settles yet.
    if (i.isButton() && prefix === CHOICE_PREFIX && value === ENTER_VALUE) {
      await i.showModal(buildAnswerModal(id, p.language));
      return;
    }
    // The answer: an option index (button, select) or the typed text (modal).
    const answer = i.isButton()
      ? value
      : i.isStringSelectMenu()
        ? i.values[0]
        : `${TYPED_PREFIX}${i.fields.getTextInputValue(ANSWER_FIELD).trim()}`;
    if (answer === undefined || answer === TYPED_PREFIX) {
      if (isModal) await i.deferUpdate(); // blank answer: keep the question open
      return;
    }
    pending.delete(id);
    clearTimeout(p.timer); // the timeout must not fire while the ack is in flight
    const line = settledLine(p, prefix, answer);
    // ACK first (3 s deadline), then the slower persistence and resolving the waiter.
    try {
      if (isModal && !i.isFromMessage())
        await i.reply({ content: line, flags: MessageFlags.Ephemeral });
      else await i.update({ content: `${p.content}\n\n${line}`, components: [] });
    } catch (err) {
      log.warn({ err: errText(err) }, "approval ack failed");
      void p.edit(`${p.content}\n\n${line}`);
    }
    settleClick(p, prefix, answer);
  } catch (err) {
    log.warn({ err: errText(err) }, "approval interaction failed");
  }
}
