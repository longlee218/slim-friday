import {
  type ActionRowBuilder,
  ContainerBuilder,
  FileBuilder,
  type MessageActionRowComponentBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { TONE_COLOR, type Tone } from "./tone";

/** What a tone container holds, in order: the text, an optional attached file, the controls. */
export interface ToneParts {
  text: string;
  /** Name of a file attached to the same message; it is exposed by a File component (a v2 message has no `content`). */
  fileName?: string;
  rows?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** One Container with the tone's accent color around text, file and controls (a v2 message holds at most 40 components). */
export function toneContainer(tone: Tone, parts: ToneParts): ContainerBuilder {
  const c = new ContainerBuilder()
    .setAccentColor(TONE_COLOR[tone])
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(parts.text || "-")); // Discord rejects an empty text display
  if (parts.fileName)
    c.addFileComponents(new FileBuilder().setURL(`attachment://${parts.fileName}`));
  if (parts.rows?.length) c.addActionRowComponents(...parts.rows);
  return c;
}
