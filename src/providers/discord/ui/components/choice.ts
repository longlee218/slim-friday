import {
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type OwnerLanguage, renderUserNotice } from "../../../../ingress/user-copy";
import { clip } from "../../../../observability/redact";
import { INTENT_STYLE, type Intent } from "./buttons";

/** customId prefix of a question; format `choice:<requestId>:<value>` (no private text, ever). */
export const CHOICE_PREFIX = "choice";
/** Value of the "Enter answer" button; the modal and the select use their own values. */
export const ENTER_VALUE = "a";
/** Value of the select menu (the picked option index arrives in `values`). */
const SELECT_VALUE = "s";
/** Value of the modal submit. */
const MODAL_VALUE = "m";
/** A typed answer settles the request as `text:<answer>`; option picks settle as their index. */
export const TYPED_PREFIX = "text:";

/** Id of the text field inside the answer modal. */
export const ANSWER_FIELD = "answer";

/** Discord limits: 5 buttons per row, 80 chars per button label, 25 select options of 100 chars. */
const BUTTONS_MAX = 5;
const BUTTON_LABEL_MAX = 80;
const SELECT_MAX = 25;
const SELECT_LABEL_MAX = 100;
const ANSWER_MAX = 1000;

/** How a question's options are offered. */
export type ChoiceLayout = "buttons" | "select" | "modal";

/** Pick the control: buttons for a few short options, a select menu for up to 25, else a typed answer. */
export function choiceLayout(options: string[]): ChoiceLayout {
  const longest = Math.max(0, ...options.map((o) => o.length));
  if (options.length >= 1 && options.length <= BUTTONS_MAX && longest <= BUTTON_LABEL_MAX)
    return "buttons";
  if (options.length > BUTTONS_MAX && options.length <= SELECT_MAX && longest <= SELECT_LABEL_MAX)
    return "select";
  return "modal";
}

/** "Enter answer" button: opens the modal. */
function enterButton(id: string, language: OwnerLanguage): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CHOICE_PREFIX}:${id}:${ENTER_VALUE}`)
      .setLabel(renderUserNotice({ kind: "approval", state: "enter" }, language))
      .setStyle(INTENT_STYLE.neutral),
  );
}

/** Controls of one question: option buttons, a select menu (plus the typing button), or the typing button alone. */
export function buildChoiceRows(
  id: string,
  options: string[],
  layout: ChoiceLayout,
  language: OwnerLanguage,
  intents: Intent[] = [],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (layout === "buttons") {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        options.map((label, i) =>
          new ButtonBuilder()
            .setCustomId(`${CHOICE_PREFIX}:${id}:${i}`)
            .setLabel(clip(label, BUTTON_LABEL_MAX))
            .setStyle(INTENT_STYLE[intents[i] ?? "choice"]),
        ),
      ),
    ];
  }
  if (layout === "select") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${CHOICE_PREFIX}:${id}:${SELECT_VALUE}`)
      .setPlaceholder(renderUserNotice({ kind: "approval", state: "placeholder" }, language))
      .addOptions(
        options.map((label, i) => ({ label: clip(label, SELECT_LABEL_MAX), value: String(i) })),
      );
    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      enterButton(id, language),
    ];
  }
  return [enterButton(id, language)];
}

/** Modal that collects a typed answer; its customId carries only the request id. */
export function buildAnswerModal(id: string, language: OwnerLanguage): ModalBuilder {
  const title = renderUserNotice({ kind: "approval", state: "modal-title" }, language);
  return new ModalBuilder()
    .setCustomId(`${CHOICE_PREFIX}:${id}:${MODAL_VALUE}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(ANSWER_FIELD)
          .setLabel(title)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(ANSWER_MAX),
      ),
    );
}
