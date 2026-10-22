import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { clip } from "../../../../observability/redact";
import type { ReportLink } from "../../ingress/discord-message-rules";

/** Discord limits: 5 buttons per row, 80 chars per label. */
const ROW_SIZE = 5;
const LABEL_MAX = 80;

/** What a button does for the owner: approve is green, reject is red, a choice is blurple, anything else is grey. */
export type Intent = "approve" | "reject" | "choice" | "neutral";

/** Discord's fixed button colors per intent. */
export const INTENT_STYLE: Record<Intent, ButtonStyle> = {
  approve: ButtonStyle.Success,
  reject: ButtonStyle.Danger,
  choice: ButtonStyle.Primary,
  neutral: ButtonStyle.Secondary,
};

/** One button: `value` is what the pending request resolves with. */
export interface ButtonSpec {
  label: string;
  value: string;
  intent: Intent;
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
              .setStyle(INTENT_STYLE[b.intent]),
          ),
      ),
    );
  }
  return rows;
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
