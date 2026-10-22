import { AttachmentBuilder, MessageFlags, type SendableChannels } from "discord.js";
import { attachmentName, headingTitle } from "../../../../ingress/attachment-name";
import { type OwnerLanguage, renderUserNotice } from "../../../../ingress/user-copy";
import { clip, redactText } from "../../../../observability/redact";
import {
  closeFence,
  markdownLinks,
  prepareOutput,
  type ReportLink,
  SAFE_MENTIONS,
  safeLinks,
} from "../../ingress/discord-message-rules";
import { PACE_TOTAL_MAX_MS, pauseMs } from "../../ingress/reply-bubbles";
import { buildLinkReport, buildReportComponents } from "../messages/report-message";

/** Temporary receipt on an accepted message whose first visible reply is delayed. */
export const BUSY_ACK_EMOJI = "👀";

/** Typing indicator lasts ~10s on Discord; refresh a bit earlier. */
const TYPING_REFRESH_MS = 8000;

/** Pause before the next bubble so a multi-part reply reads like a person typing. */
type Delay = (ms: number) => Promise<void>;

/**
 * Send a reply as redacted, non-pinging messages, one per paragraph, with a short "typing" pause between them
 * (total pause capped). A mid-length reply (or one with a table) is one inline report message. A long reply or a
 * diff is sent as short bubbles + a titled file: the `.md` rides in a report message (the last bubble is its summary),
 * a `.diff` is attached to the last bubble.
 * `visible` runs once, after the first message has landed. `delay` is injectable for tests.
 */
export async function sendReply(
  channel: SendableChannels,
  text: string,
  language: OwnerLanguage,
  visible?: () => Promise<void>,
  delay: Delay = Bun.sleep,
): Promise<void> {
  const { bubbles, file, report } = prepareOutput(text, language);
  if (report !== undefined) {
    await sendReport(channel, { summary: report });
    await visible?.();
    return;
  }
  const asReport = !!file && !file.name.endsWith(".diff");
  let spent = 0; // total pause so far
  for (const [i, bubble] of bubbles.entries()) {
    if (i > 0) {
      const ms = Math.min(pauseMs(bubble.length), PACE_TOTAL_MAX_MS - spent);
      if (ms > 0) {
        channel.sendTyping().catch(() => {});
        await delay(ms);
        spent += ms;
      }
    }
    const last = i === bubbles.length - 1;
    if (asReport && last)
      await sendReport(channel, {
        summary: bubble,
        markdown: file.content,
        fileName: file.name,
      });
    else {
      const files =
        file && last ? [new AttachmentBuilder(Buffer.from(file.content), { name: file.name })] : [];
      await channel.send({ content: bubble, files, allowedMentions: SAFE_MENTIONS });
    }
    if (i === 0) await visible?.();
  }
}

/** Post a finished result as an attached file (`fileName`: from its title) with a short label (the lead adds its own summary). */
export async function sendResultFile(
  channel: SendableChannels,
  text: string,
  language: OwnerLanguage,
  visible?: () => Promise<void>,
  fileName?: string,
  links?: ReportLink[],
): Promise<void> {
  const summary = renderUserNotice({ kind: "label", state: "full-result" }, language);
  // Viewer on (a signed link exists): link only, no file. Viewer off: the `.md` file is the only way to read it.
  const safe = safeLinks(links ?? []);
  if (safe.length) {
    const body = redactText(text);
    await channel.send({
      components: [buildLinkReport(headingTitle(body), body, safe, summary)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: SAFE_MENTIONS,
    });
    await visible?.();
    return;
  }
  await sendReport(channel, { summary, markdown: text, fileName, links });
  await visible?.();
}

/** A components-v2 text display holds up to 4000 chars; stay below. */
const SUMMARY_MAX = 3900;

/**
 * Send a structured report as one components-v2 message (no `content`/`embeds`, no pings): redacted
 * summary text, the full Markdown as an attached file exposed by a File component (Mermaid source kept
 * verbatim, not rendered), and up to three link buttons from safe absolute http(s) links only.
 * Throws when the send fails, so callers' "visible" bookkeeping never records a reply that did not land.
 */
export async function sendReport(
  channel: SendableChannels,
  report: { summary: string; markdown?: string; fileName?: string; links?: ReportLink[] },
): Promise<void> {
  const fileName = report.fileName ?? attachmentName(undefined, "md"); // the attached Markdown's name
  const markdown = report.markdown === undefined ? undefined : redactText(report.markdown);
  // Redaction can lengthen the text, so clip after it; a cut inline report must not leave a code fence open.
  const summary = closeFence(clip(redactText(report.summary), SUMMARY_MAX)) || "-";
  const links = safeLinks([...(report.links ?? []), ...markdownLinks(markdown ?? summary)]);
  await channel.send({
    components: buildReportComponents(
      summary,
      markdown === undefined ? undefined : fileName,
      links,
    ),
    files:
      markdown === undefined
        ? []
        : [new AttachmentBuilder(Buffer.from(markdown), { name: fileName })],
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

/** Post one image as an attachment (a screenshot a report sends to the owner, once). */
export async function sendImage(
  channel: SendableChannels,
  image: { name: string; bytes: Uint8Array },
): Promise<void> {
  await channel.send({
    files: [new AttachmentBuilder(Buffer.from(image.bytes), { name: image.name })],
    allowedMentions: SAFE_MENTIONS,
  });
}
