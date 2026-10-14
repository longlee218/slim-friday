import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { clip } from "../observability/redact";
import type { ReportLink } from "./discord-message-rules";
import {
  languageOf,
  type OwnerLanguage,
  pinnedThreadLanguage,
  renderUserNotice,
} from "./user-copy";

/** customId prefix of a question; format `choice:<requestId>:<value>` (no private text, ever). */
export const CHOICE_PREFIX = "choice";
/** Value of the "Enter answer" button; the modal and the select use their own values. */
export const ENTER_VALUE = "a";
/** Value of the select menu (the picked option index arrives in `values`). */
export const SELECT_VALUE = "s";
/** Value of the modal submit. */
export const MODAL_VALUE = "m";
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
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Controls of one question: option buttons, a select menu (plus the typing button), or the typing button alone. */
export function buildChoiceRows(
  id: string,
  options: string[],
  layout: ChoiceLayout,
  language: OwnerLanguage,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (layout === "buttons") {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        options.map((label, i) =>
          new ButtonBuilder()
            .setCustomId(`${CHOICE_PREFIX}:${id}:${i}`)
            .setLabel(clip(label, BUTTON_LABEL_MAX))
            .setStyle(ButtonStyle.Primary),
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

/**
 * Language of a thread: the one ingress pinned for its messages. Only when none is pinned yet (e.g. a notice right
 * after a restart) it falls back to the latest task brief; Vietnamese when unknown.
 */
export function threadLanguage(db: Database, threadId: string): OwnerLanguage {
  const pinned = pinnedThreadLanguage(threadId);
  if (pinned) return pinned;
  const last = db
    .query<{ brief: string | null }, [string]>(
      "SELECT brief FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(threadId);
  return languageOf(last?.brief ?? "");
}

/** Row of link buttons (they navigate, never send an interaction); undefined when there is no link. */
export function buildLinkRow(links: ReportLink[]): ActionRowBuilder<ButtonBuilder> | undefined {
  if (!links.length) return undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    links.map((l) =>
      new ButtonBuilder().setLabel(l.label).setURL(l.url).setStyle(ButtonStyle.Link),
    ),
  );
}

/**
 * Components-v2 layout of a report: summary text, the attached file exposed by a File component
 * (v2 messages have no `content`, so an attachment must be referenced), then link buttons.
 */
export function buildReportComponents(
  summary: string,
  fileName?: string,
  links: ReportLink[] = [],
): (TextDisplayBuilder | FileBuilder | ActionRowBuilder<ButtonBuilder>)[] {
  const parts: (TextDisplayBuilder | FileBuilder | ActionRowBuilder<ButtonBuilder>)[] = [
    new TextDisplayBuilder().setContent(summary),
  ];
  if (fileName) parts.push(new FileBuilder().setURL(`attachment://${fileName}`));
  const row = buildLinkRow(links);
  if (row) parts.push(row);
  return parts;
}
