import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Attachment,
  type Author,
  buildWakePrompt,
  INTERRUPTED_NOTE,
  type InboundTurn,
} from "@friday/core";
import type { UserContent } from "./input-queue";

/** Image types the model reads inline. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Largest image sent inline, in bytes; a bigger one is left as a file. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/** Display name of an author: the user, the system, or a bot by name (its id when the name is unknown). */
function nameOf(author: Author, names: Record<string, string>): string {
  if (author.kind === "bot") return names[author.botId] ?? author.botId;
  return author.kind;
}

/**
 * The text a bot reads for one inbound turn: a header naming the conversation, the sender and the hop,
 * then the message. A group turn with context starts with the recent messages; the last context
 * message is left out when it is the triggering message itself. Changed group memory comes first.
 */
export function formatTurn(turn: InboundTurn, names: Record<string, string>): string {
  const last = turn.context.at(-1);
  const recent = last && last.text === turn.text ? turn.context.slice(0, -1) : turn.context;
  const block = recent.length
    ? `Recent messages:\n${recent.map((m) => `${nameOf(m.author, names)}: ${m.text}`).join("\n")}\n\n`
    : "";
  const tickets = turn.tickets ? `${turn.tickets}\n\n` : "";
  const memory = turn.groupMemory ? `Group memory:\n${turn.groupMemory}\n\n` : "";
  // A bot's message is wrapped as untrusted peer content with what is expected of the receiver.
  const body =
    turn.from.kind === "bot"
      ? buildWakePrompt({
          from: { id: turn.from.botId, name: nameOf(turn.from, names) },
          text: turn.text,
          intent: turn.intent ?? "request",
          ...(turn.handoff && { handoff: true }),
        })
      : turn.text;
  const note = turn.interrupted ? `${INTERRUPTED_NOTE}\n\n` : "";
  return `${tickets}${memory}${block}${note}[conversation ${turn.conversationId}] ${nameOf(turn.from, names)} (hop ${turn.hop}):\n${body}`;
}

/**
 * What the SDK receives for one turn: the formatted text alone, or, when the user attached files, content blocks:
 * one text block (the turn plus an `Attached files:` list) and one base64 image block per small image. Every other
 * file (and a big image) is copied into a fresh dir under `<scratchDir>/inbox/` and listed by path, so the bot can `Read` it.
 */
export function turnContent(
  turn: InboundTurn,
  names: Record<string, string>,
  scratchDir: string,
): UserContent {
  const text = formatTurn(turn, names);
  if (!turn.attachments?.length) return text;
  const images: UserContent = [];
  const lines: string[] = [];
  let copyDir: string | undefined;
  for (const a of turn.attachments) {
    if (INLINE_IMAGES.has(a.mimeType) && a.size <= MAX_INLINE_BYTES) {
      images.push(imageBlock(a));
      lines.push(`- ${a.name} (${a.mimeType}, shown above)`);
      continue;
    }
    if (!copyDir) {
      mkdirSync(join(scratchDir, "inbox"), { recursive: true });
      copyDir = mkdtempSync(join(scratchDir, "inbox", "t-"));
    }
    const dest = join(copyDir, basename(a.name));
    copyFileSync(a.path, dest);
    lines.push(`- ${dest} (${a.mimeType}, ${a.size} bytes)`);
  }
  return [{ type: "text", text: `${text}\n\nAttached files:\n${lines.join("\n")}` }, ...images];
}

/** A base64 image content block of a saved file. */
function imageBlock(a: Attachment) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: a.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
      data: readFileSync(a.path).toString("base64"),
    },
  };
}
