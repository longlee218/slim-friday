import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Attachment,
  type Author,
  buildWakePrompt,
  INTERRUPTED_NOTE,
  type InboundTurn,
  type StoredMessage,
} from "@friday/core";
import { currentTimeText } from "./current-time";
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

/** One "Recent messages" line: a relay reads `<from> → <to> (<intent>): <text>`, any other `<author>: <text>`. */
function contextLine(m: StoredMessage, names: Record<string, string>): string {
  const r = m.relay;
  if (m.kind !== "relay" || !r) return `${nameOf(m.author, names)}: ${m.text}`;
  const name = (id: string) => names[id] ?? id;
  return `${name(r.fromBotId)} → ${name(r.toBotId)} (${r.intent}): ${oneLine(m.text)}`;
}

/** Longest quoted or relayed text kept in the prompt, in code points. */
const QUOTE_MAX = 300;

/** Collapses all whitespace (newlines too) so quoted text cannot start a line of its own, then cuts by code points. */
function oneLine(s: string): string {
  return [...s.replace(/\s+/g, " ").trim()].slice(0, QUOTE_MAX).join("");
}

/** First line of a turn whose text comes from Friday, not from its sender (spec §6.4, R§7). */
export const AUTOMATED_LABEL = "[Automated message from Friday, not from the owner]";

/**
 * The text a bot reads for one inbound turn (spec §6.4): the automated label when Friday wrote it, the interrupted
 * note, the `<state_changed>` block of a resumed session, a header naming the conversation, the sender and the hop, the quote line and the message (a bot's message
 * wrapped as untrusted peer content); then the recent group messages (the last one left out when it is the
 * triggering message itself), ticket blocks and recalled notes; then the reply guidance, the computer slot line and the current time in
 * the owner's zone. Group context and memory are in the system prompt.
 */
export function formatTurn(turn: InboundTurn, names: Record<string, string>): string {
  const last = turn.context.at(-1);
  const recent = last && last.text === turn.text ? turn.context.slice(0, -1) : turn.context;
  const body =
    turn.from.kind === "bot"
      ? buildWakePrompt({
          from: { id: turn.from.botId, name: nameOf(turn.from, names) },
          text: turn.text,
        })
      : turn.text;
  const quote = turn.quote
    ? `> Replying to ${nameOf(turn.quote.author, names)}: ${oneLine(turn.quote.text)}\n`
    : "";
  const message = `[conversation ${turn.conversationId}] ${nameOf(turn.from, names)} (hop ${turn.hop}):\n${quote}${body}`;
  const blocks = [
    turn.automated ? AUTOMATED_LABEL : undefined,
    turn.interrupted ? INTERRUPTED_NOTE : undefined,
    turn.stateChanged,
    message,
    recent.length
      ? `Recent messages:\n${recent.map((m) => contextLine(m, names)).join("\n")}`
      : undefined,
    turn.tickets,
    turn.recalled,
    turn.guidance,
    turn.computerSlots,
    currentTimeText(turn.now, turn.timeZone),
  ];
  return blocks.filter(Boolean).join("\n\n");
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
  return withAttachments(formatTurn(turn, names), turn.attachments, scratchDir);
}

/** `text` alone, or, with files, content blocks as `turnContent` describes (also used for steering pushes). */
export function withAttachments(
  text: string,
  attachments: Attachment[] | undefined,
  scratchDir: string,
): UserContent {
  if (!attachments?.length) return text;
  const images: UserContent = [];
  const lines: string[] = [];
  let copyDir: string | undefined;
  for (const a of attachments) {
    // A file swept or removed since the message came is named in a note; it must not fail the turn.
    try {
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
    } catch {
      lines.push(`- [file no longer available: ${a.name}]`);
    }
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
