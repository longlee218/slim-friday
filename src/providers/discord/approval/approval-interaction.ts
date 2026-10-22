import type { Database } from "bun:sqlite";
import type { Interaction } from "discord.js";
import type { Logger } from "pino";
import { threadLanguage } from "../../../ingress/thread-language";
import { type OwnerLanguage, renderUserNotice } from "../../../ingress/user-copy";
import { errText } from "../../../observability/redact";
import {
  ANSWER_FIELD,
  buildAnswerModal,
  CHOICE_PREFIX,
  ENTER_VALUE,
  TYPED_PREFIX,
} from "../ui/components/choice";
import { settledPayload } from "../ui/messages/ask-message";
import { replyEphemeral, updateMessage } from "../ui/send/reply-port";
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
  i: Parameters<typeof replyEphemeral>[0],
  state: "owner-only" | "expired",
  language: OwnerLanguage,
) => replyEphemeral(i, renderUserNotice({ kind: "approval", state }, language));

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
    // The clicked button decides the color: a reject (deny, "No") is red, anything chosen or approved is green.
    const index = prefix === "appr" ? (answer === "allow" ? 0 : 1) : Number(answer);
    const tone = p.intents[index] === "reject" ? "error" : "ok";
    const settled = settledPayload(`${p.content}\n\n${line}`, tone, p.fileName);
    // ACK first (3 s deadline), then the slower persistence and resolving the waiter.
    try {
      if (isModal && !i.isFromMessage()) await replyEphemeral(i, line);
      else await updateMessage(i, settled);
    } catch (err) {
      log.warn({ err: errText(err) }, "approval ack failed");
      void p.edit(`${p.content}\n\n${line}`, tone);
    }
    settleClick(p, prefix, answer);
  } catch (err) {
    log.warn({ err: errText(err) }, "approval interaction failed");
  }
}
