import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { FileBuilder, TextDisplayBuilder } from "discord.js";
import type { ReportLink } from "../../ingress/discord-message-rules";
import { buildLinkRow } from "../components/buttons";

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
