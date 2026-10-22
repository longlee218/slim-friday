import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { FileBuilder, TextDisplayBuilder } from "discord.js";
import type { ReportLink } from "../../ingress/discord-message-rules";
import { buildLinkRow } from "../components/buttons";
import { toneContainer } from "../components/container";
import { note, subtext } from "./hints";

/** Chars of the report body shown in a link-only report; the rest is behind the link. */
export const LINK_REPORT_EXCERPT = 600;

/**
 * Link-only report (viewer on): one green Container with the title, an italic excerpt of the body and the Open link.
 * No file is attached: the link is the one way to read the full text.
 */
export function buildLinkReport(
  title: string | undefined,
  body: string,
  links: ReportLink[],
  hint: string,
) {
  const clean = body.replace(/^#[^\n]*\n+/, "").trim();
  const cut =
    clean.length > LINK_REPORT_EXCERPT
      ? `${clean.slice(0, LINK_REPORT_EXCERPT).trimEnd()}…`
      : clean;
  const text = [title && `**${title}**`, cut && note(cut), subtext(hint)]
    .filter(Boolean)
    .join("\n\n");
  const row = buildLinkRow(links);
  return toneContainer("ok", { text, rows: row ? [row] : [] });
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
