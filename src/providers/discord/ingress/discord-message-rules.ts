import { attachmentName, headingTitle } from "../../../ingress/attachment-name";
import { type OwnerLanguage, renderUserNotice } from "../../../ingress/user-copy";
import { clip, redactText } from "../../../observability/redact";
import { isAdminText } from "../setup/admin-command";
import { INLINE_MAX, wrapTables } from "./inline-report";
import { needsFile, needsReport, paragraphs, splitReply, toBubbles } from "./reply-bubbles";

// Link helpers live in report-links.ts; re-exported because several modules import them from here.
export { CHUNK_MAX } from "../../../ingress/message-limits";
export { markdownLinks, type ReportLink, safeLinks } from "../../../ingress/report-links";

import { CHUNK_MAX } from "../../../ingress/message-limits";

/** Mention policy for every outgoing message: nothing can ping (@everyone, @here, roles, users). */
export const SAFE_MENTIONS = { parse: [] as never[], repliedUser: false };

/** Truncation cap of a reply and inline head size before a file (the chunk size, `CHUNK_MAX`, is in `ingress/message-limits`). */
export const REPLY_CAP = 6000;
export const HEAD_MAX = 1500;

/** A text that is a whole html document (starts with a doctype or the html tag): its file must not be named `.md`. */
const HTML_DOCUMENT = /^\s*(<!doctype\s+html|<html[\s>])/i;

/** Minimal message facts the routing rules need (decoupled from discord.js types). */
export interface MessageFacts {
  authorId: string;
  authorIsBot: boolean;
  /** False for DMs. */
  inGuild: boolean;
  /** True when a guild is pinned (DISCORD_GUILD_ID) and the message is from another one. */
  otherGuild: boolean;
  /** True when the channel is a thread created by this bot. */
  inBotThread: boolean;
  /** True for an adopted owner-made thread (acts like `inBotThread`). */
  adoptedThread?: boolean;
  /** True for an owner-made thread under a mapped channel, not yet adopted (not in an ops channel). */
  adoptableThread?: boolean;
  /** True for a channel (not a thread) the owner marked `mode: chat`: the owner needs no mention there. */
  chatChannel?: boolean;
  /** True when the message mentions this bot. */
  mentionsBot: boolean;
  content: string;
  /** The message carries files, so an empty text is not "empty". */
  hasAttachments?: boolean;
  /** True when the channel (or the parent of its thread) is an ops channel from discord.yaml. */
  opsChannel?: boolean;
  /** True when the channel itself (not a thread) is a discord.yaml control channel. */
  controlChannel?: boolean;
}

/** Routing decision for one message. */
export type Route =
  | {
      kind: "ignore";
      reason:
        | "bot"
        | "not_owner"
        | "dm"
        | "other_guild"
        | "ops_channel"
        | "empty"
        | "not_mentioned";
    }
  /** Admin text (control channel, or `/teammate` typed anywhere): handled by the admin gate, never by the agent. */
  | { kind: "control"; prompt: string }
  /** Continue the session of the thread (or chat channel) the message is in. */
  | { kind: "thread"; prompt: string }
  /** Owner @mention in an adoptable owner-made thread: the handler persists the adoption, then answers as `thread`. */
  | { kind: "adopt"; prompt: string }
  /** New conversation: create a thread from the message. */
  | { kind: "channel"; prompt: string };

/** Remove the bot mention and trim. */
export function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** Decide what to do with a message. Non-owners and bots never get past `ignore`; admin text elsewhere is refused by the gate, never sent to the agent. */
export function routeMessage(f: MessageFacts, ownerId: string, botId: string): Route {
  if (f.authorIsBot) return { kind: "ignore", reason: "bot" };
  if (f.authorId !== ownerId) return { kind: "ignore", reason: "not_owner" };
  if (!f.inGuild) return { kind: "ignore", reason: "dm" };
  if (f.otherGuild) return { kind: "ignore", reason: "other_guild" };
  const prompt = stripMention(f.content, botId);
  if (!prompt && !f.hasAttachments) return { kind: "ignore", reason: "empty" };
  // Ops channels (and their threads) never reach the agent: only admin handling.
  if (f.opsChannel)
    return f.controlChannel || isAdminText(prompt)
      ? { kind: "control", prompt }
      : { kind: "ignore", reason: "ops_channel" };
  // Bot-owned or adopted thread, or a chat channel (the channel is the thread): no mention needed.
  const inThread = f.inBotThread || !!f.adoptedThread || !!f.chatChannel;
  if (isAdminText(prompt) && (inThread || f.mentionsBot)) return { kind: "control", prompt };
  if (inThread) return { kind: "thread", prompt };
  // An owner-made thread under a mapped channel: the first mention adopts it (never a thread inside a thread).
  if (f.adoptableThread && f.mentionsBot) return { kind: "adopt", prompt };
  // Outside a bot thread the owner must mention the bot explicitly.
  if (f.mentionsBot) return { kind: "channel", prompt };
  return { kind: "ignore", reason: "not_mentioned" };
}

/** Lines of the text, with any line longer than `max` cut. */
function toPieces(text: string, max: number): string[] {
  const cutter = new RegExp(`.{1,${max}}`, "gs");
  return text
    .split("\n")
    .flatMap((line) => (line.length <= max ? [line] : (line.match(cutter) ?? [])));
}

/** Split into chunks <= max chars by line; an open ``` fence is closed and reopened. `max` 1900: +1 per newline and fence markers (<= 8) fit under Discord's 2000. */
export function splitChunks(text: string, max = CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let cur: string[] = []; // lines of the chunk being built
  let len = 0;
  let inFence = false; // inside a ``` block at the current position
  for (const line of toPieces(text, max)) {
    if (cur.length && len + line.length > max) {
      chunks.push((inFence ? [...cur, "```"] : cur).join("\n"));
      cur = inFence ? ["```"] : [];
      len = cur.length ? 4 : 0;
    }
    cur.push(line);
    len += line.length + 1;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
  }
  chunks.push(cur.join("\n"));
  return chunks;
}

/** Outbound guardrail: redact secrets again, cap length with a notice, split for Discord. */
export function prepareReply(text: string): string[] {
  let safe = redactText(text);
  if (safe.length > REPLY_CAP) safe = `${safe.slice(0, REPLY_CAP)}\n\n[output truncated]`;
  // Discord rejects empty messages: drop blank chunks.
  const chunks = splitChunks(safe).filter((c) => c.trim() !== "");
  return chunks.length ? chunks : ["(no answer)"];
}

/** A reply sent as a head message plus one redacted file. */
export interface OutputFile {
  /** Filesystem-safe attachment name (see `attachment-name.ts`). */
  name: string;
  content: string;
}

/** True when ```diff blocks make up more than half of the text. */
function isMainlyDiff(text: string): boolean {
  const blocks = [...text.matchAll(/```diff\n[\s\S]*?(?:```|$)/g)];
  return blocks.reduce((n, [b]) => n + b.length, 0) > text.length / 2;
}

/** `text` with an open ``` fence closed (a cut text must not swallow the rest of the message). */
export function closeFence(text: string): string {
  return (text.match(/^\s*```/gm) ?? []).length % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/** First ~HEAD_MAX chars, cut on a line boundary, with an open ``` fence closed. */
function headOf(text: string, language: OwnerLanguage): string {
  const cut = text.slice(0, HEAD_MAX);
  const head = cut.length < text.length ? cut.slice(0, Math.max(cut.lastIndexOf("\n"), 1)) : cut;
  return `${closeFence(head)}\n\n${renderUserNotice({ kind: "label", state: "reply-attached" }, language)}`;
}

/** The paragraphs as redacted, capped chat messages, never empty (Discord rejects an empty message). */
function bubblesOf(text: string): string[] {
  const bubbles = toBubbles(text)
    .flatMap(prepareReply)
    .filter((b) => b !== "(no answer)");
  return bubbles.length ? bubbles : ["(no answer)"];
}

/**
 * What to send for a reply, redacted: chat bubbles plus an optional file, or one inline `report` (no bubbles, no file).
 * - text after `---`, or a reply over INLINE_MAX / with a long code block: chat part (or first paragraph) + full file
 * - mainly a diff: a head + a `.diff` file;
 * - over ATTACH_MIN chars or with a table (and short enough): the inline report;
 * - otherwise bubbles only.
 */
export function prepareOutput(
  text: string,
  language: OwnerLanguage,
): { bubbles: string[]; file?: OutputFile; report?: string } {
  const safe = redactText(text);
  if (isMainlyDiff(safe)) {
    const prefix = `${new Date().toISOString().slice(0, 10)}-`;
    const name = attachmentName(headingTitle(safe), "diff", { fallback: "changes", prefix });
    return { bubbles: [headOf(safe, language)], file: { name, content: safe } };
  }
  const { chat, detail, split } = splitReply(safe);
  const asFile = (chatText: string, content: string, title?: string) => {
    // No chat part: use the first paragraph. Cut at HEAD_MAX so it fits MAX_BUBBLES messages.
    const head = closeFence(clip(chatText || (paragraphs(content)[0] ?? ""), HEAD_MAX));
    // An html document keeps `.html` (the model's title still names it); everything else is Markdown.
    const ext = HTML_DOCUMENT.test(content) ? "html" : "md";
    return { bubbles: bubblesOf(head), file: { name: attachmentName(title, ext), content } };
  };
  if (split && detail) return asFile(chat, `${chat}\n\n${detail}`.trim(), headingTitle(detail));
  const body = split ? chat : safe;
  if (!needsFile(safe) && needsReport(body)) {
    const report = wrapTables(body); // the wrap adds a few chars: re-check the inline limit
    if (report.length <= INLINE_MAX) return { bubbles: [], report };
  }
  if (needsFile(safe) || needsReport(body))
    return asFile(split ? chat : "", body, headingTitle(body));
  return { bubbles: bubblesOf(chat) };
}
