import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  MessageFlags,
} from "discord.js";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";
import { UUID_RE } from "../workspaces/clone-safety";
import type { DecisionPost } from "./approval-types";

/* Keep/Discard buttons of a local result. customId = `clone:<keep|discard>:<taskId>`. The pending clicks live in
   memory only: after a restart a click finds nothing and answers "expired" (fails closed, no side effect). */

/** customId prefix of these buttons. */
export const CLONE_PREFIX = "clone";
/** Hard cap of the message (Discord allows 2000). */
export const DECISION_MESSAGE_MAX = 1800;
/** Reply to a click that matches no open decision. */
export const EXPIRED_REPLY = "This action expired.";
/** Ephemeral answer when the Keep/Discard action itself failed; the buttons stay usable. */
const ACTION_FAILED_REPLY = "The action failed; try again or use /cleanup.";

const log = logger.child({ module: "clone-decision" });

/** The two choices; the value is the middle part of the customId. */
const CHOICES = { keep: "Keep", discard: "Discard" } as const;
const isChoice = (v: string | undefined): v is keyof typeof CHOICES =>
  v !== undefined && Object.hasOwn(CHOICES, v);

/** A posted message waiting for a click. */
interface Open {
  content: string;
  onClick: DecisionPost["onClick"];
}

/** Poster + click handler of the Keep/Discard message. */
export function createDecisionPoster(deps: {
  getClient: () => Client | undefined;
  ownerId: string;
}) {
  /** Open decisions by task id. */
  const open = new Map<string, Open>();

  return {
    /** Send the message with its buttons; never waits for an answer. */
    async post(req: DecisionPost): Promise<boolean> {
      try {
        const channel = await deps.getClient()?.channels.fetch(req.threadId);
        if (!channel?.isSendable()) throw new Error("no channel");
        const content = redactText(req.content).slice(0, DECISION_MESSAGE_MAX);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          (Object.keys(CHOICES) as (keyof typeof CHOICES)[]).map((c) =>
            new ButtonBuilder()
              .setCustomId(`${CLONE_PREFIX}:${c}:${req.turnId}`)
              .setLabel(CHOICES[c])
              .setStyle(c === "keep" ? ButtonStyle.Success : ButtonStyle.Danger),
          ),
        );
        await channel.send({
          content,
          components: [row],
          files: req.filePath ? [new AttachmentBuilder(req.filePath)] : [],
          allowedMentions: SAFE_MENTIONS,
        });
        open.set(req.turnId, { content, onClick: req.onClick });
        return true;
      } catch (err) {
        log.warn({ err: errText(err) }, "result message failed");
        return false;
      }
    },

    /** Handle a click; true when the interaction was one of ours (handled or refused), false to let others look. */
    async handle(i: Interaction): Promise<boolean> {
      if (!i.isButton()) return false;
      const [prefix, choice, taskId, ...extra] = i.customId.split(":");
      if (prefix !== CLONE_PREFIX) return false;
      try {
        if (i.user.id !== deps.ownerId) {
          await i.reply({ content: "Only the owner can decide.", flags: MessageFlags.Ephemeral });
          return true;
        }
        const entry =
          isChoice(choice) && taskId && UUID_RE.test(taskId) && extra.length === 0
            ? open.get(taskId)
            : undefined;
        if (!entry || !isChoice(choice) || !taskId) {
          await i.reply({ content: EXPIRED_REPLY, flags: MessageFlags.Ephemeral });
          return true;
        }
        // One decision per message: a second click is expired. The entry is restored when the action throws.
        open.delete(taskId);
        let text: string;
        try {
          text = await entry.onClick(choice);
        } catch (err) {
          open.set(taskId, entry);
          log.warn({ err: errText(err) }, "clone decision action failed");
          await i.reply({ content: ACTION_FAILED_REPLY, flags: MessageFlags.Ephemeral });
          return true;
        }
        await i.update({
          content: `${entry.content}\n\n${text}`.slice(0, DECISION_MESSAGE_MAX + 200),
          components: [],
        });
      } catch (err) {
        log.warn({ err: errText(err) }, "clone decision failed");
      }
      return true;
    },
  };
}
