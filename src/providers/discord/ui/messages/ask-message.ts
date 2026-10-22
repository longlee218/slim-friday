import { AttachmentBuilder, MessageFlags } from "discord.js";
import { SAFE_MENTIONS } from "../../ingress/discord-message-rules";
import { type ToneParts, toneContainer } from "../components/container";
import type { Tone } from "../components/tone";

/** A file posted under a question (a long question or the options that do not fit a control). */
export interface AskFile {
  name: string;
  content: string;
}

/**
 * A question or approval as one components-v2 message: a blurple Container with the text, the file (if any) and the
 * controls. A v2 message has no `content`; the file is exposed by a File component inside the Container.
 */
export function askPayload(text: string, rows: NonNullable<ToneParts["rows"]>, file?: AskFile) {
  return {
    components: [toneContainer("ask", { text, fileName: file?.name, rows })],
    files: file ? [new AttachmentBuilder(Buffer.from(file.content), { name: file.name })] : [],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: SAFE_MENTIONS,
  };
}

/**
 * The same message once settled (answered, denied, timed out, cancelled): no controls, the accent color tells the
 * outcome (green approved or chosen, red denied, yellow timed out, grey cancelled). The file stays visible.
 */
export function settledPayload(text: string, tone: Tone, fileName?: string) {
  return {
    components: [toneContainer(tone, { text, fileName })],
    flags: MessageFlags.IsComponentsV2 as const,
  };
}
