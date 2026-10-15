import { AttachmentBuilder, MessageFlags, type SendableChannels } from "discord.js";
import { clip, redactText } from "../observability/redact";
import { buildReportComponents } from "./discord-components";
import {
  markdownLinks,
  prepareOutput,
  type ReportLink,
  SAFE_MENTIONS,
  safeLinks,
} from "./discord-message-rules";
import type { OwnerLanguage } from "./user-copy";

/** Temporary receipt on an accepted message whose first visible reply is delayed. */
export const BUSY_ACK_EMOJI = "👀";

/** Typing indicator lasts ~10s on Discord; refresh a bit earlier. */
const TYPING_REFRESH_MS = 8000;

/** Send a (possibly long) reply as redacted, chunked, non-pinging messages; a very long one or a diff as head + file. */
export async function sendReply(
  channel: SendableChannels,
  text: string,
  language: OwnerLanguage,
  visible?: () => Promise<void>,
): Promise<void> {
  const { chunks, file } = prepareOutput(text, language);
  // A long Markdown reply is a structured report: summary + file component (+ link buttons).
  if (file?.name === "reply.md") {
    await sendReport(channel, { summary: chunks[0]!, markdown: file.content });
    await visible?.();
    return;
  }
  for (const [i, chunk] of chunks.entries()) {
    const files =
      file && i === chunks.length - 1
        ? [new AttachmentBuilder(Buffer.from(file.content), { name: file.name })]
        : [];
    await channel.send({ content: chunk, files, allowedMentions: SAFE_MENTIONS });
    if (i === 0) await visible?.();
  }
}

/** A components-v2 text display holds up to 4000 chars; stay below. */
const SUMMARY_MAX = 3900;
/** Name of the attached Markdown report. */
const REPORT_FILE = "reply.md";

/**
 * Send a structured report as one components-v2 message (no `content`/`embeds`, no pings): redacted
 * summary text, the full Markdown as an attached file exposed by a File component (Mermaid source kept
 * verbatim, not rendered), and up to three link buttons from safe absolute http(s) links only.
 * Throws when the send fails, so callers' "visible" bookkeeping never records a reply that did not land.
 */
export async function sendReport(
  channel: SendableChannels,
  report: { summary: string; markdown?: string; links?: ReportLink[] },
): Promise<void> {
  const markdown = report.markdown === undefined ? undefined : redactText(report.markdown);
  const summary = clip(redactText(report.summary), SUMMARY_MAX) || "-";
  const links = safeLinks([...(report.links ?? []), ...markdownLinks(markdown ?? summary)]);
  await channel.send({
    components: buildReportComponents(
      summary,
      markdown === undefined ? undefined : REPORT_FILE,
      links,
    ),
    files:
      markdown === undefined
        ? []
        : [new AttachmentBuilder(Buffer.from(markdown), { name: REPORT_FILE })],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: SAFE_MENTIONS,
  });
}

/** Show the typing indicator until the returned stop function is called. */
export function startTyping(channel: SendableChannels): () => void {
  const ping = () => {
    channel.sendTyping().catch(() => {});
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}
