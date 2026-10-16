import { isAdminText } from "../discord-setup/admin-command";
import { clip, redactText } from "../observability/redact";
import { needsFile, paragraphs, splitReply, toBubbles } from "./reply-bubbles";
import { type OwnerLanguage, renderUserNotice } from "./user-copy";

/** Mention policy for every outgoing message: nothing can ping (@everyone, @here, roles, users). */
export const SAFE_MENTIONS = { parse: [] as never[], repliedUser: false };

/** Discord hard limit is 2000; stay under it. */
export const CHUNK_MAX = 1900;
/** Replies longer than this are truncated. */
export const REPLY_CAP = 6000;
/** Size of the inline head sent before the attachment. */
export const HEAD_MAX = 1500;

/** Minimal message facts the routing rules need (decoupled from discord.js types). */
export interface MessageFacts {
  authorId: string;
  authorIsBot: boolean;
  /** False for DMs. */
  inGuild: boolean;
  /** True when a guild is pinned (DISCORD_GUILD_ID) and the message comes from another one. */
  otherGuild: boolean;
  /** True when the channel is a thread created by this bot. */
  inBotThread: boolean;
  /** True when the channel is an owner-made thread already adopted (acts like `inBotThread`). */
  adoptedThread?: boolean;
  /** True for a thread under a channel mapped to a space that is not bot-owned, not adopted, not in an ops channel. */
  adoptableThread?: boolean;
  /** True for a channel (not a thread) the owner marked `mode: chat`: the owner needs no mention there. */
  chatChannel?: boolean;
  /** True when the message mentions this bot. */
  mentionsBot: boolean;
  content: string;
  /** The message carries files: an empty text is then not "empty" (the files are read later). */
  hasAttachments?: boolean;
  /** True when the channel (or the parent of its thread) is an ops channel from discord.yaml. */
  opsChannel?: boolean;
  /** True when the channel itself (not a thread) accepts admin commands (discord.yaml controlChannels). */
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
  /** Admin text (control channel, or `/init-workspace` typed anywhere): handled by the admin gate, never by the agent. */
  | { kind: "control"; prompt: string }
  /** Continue the session of the thread (or chat channel) the message is in. */
  | { kind: "thread"; prompt: string }
  /** Owner @mention in an adoptable owner-made thread: the handler persists the adoption, then answers as `thread`. */
  | { kind: "adopt"; prompt: string }
  /** New conversation: create a thread from the message. */
  | { kind: "channel"; prompt: string };

/** Remove the bot mention (`<@id>` / `<@!id>`) and trim. */
export function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** Decide what to do with a message. Non-owners and bots never get past `ignore`. */
export function routeMessage(f: MessageFacts, ownerId: string, botId: string): Route {
  if (f.authorIsBot) return { kind: "ignore", reason: "bot" };
  if (f.authorId !== ownerId) return { kind: "ignore", reason: "not_owner" };
  if (!f.inGuild) return { kind: "ignore", reason: "dm" };
  if (f.otherGuild) return { kind: "ignore", reason: "other_guild" };
  const prompt = stripMention(f.content, botId);
  if (!prompt && !f.hasAttachments) return { kind: "ignore", reason: "empty" };
  // Ops channels (and their threads) never reach the agent: only admin handling, which re-checks the gate.
  if (f.opsChannel)
    return f.controlChannel || isAdminText(prompt)
      ? { kind: "control", prompt }
      : { kind: "ignore", reason: "ops_channel" };
  // Admin text anywhere else is refused by the gate, never sent to the agent.
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

/** Break text into lines, cutting any line too long to ever fit in one chunk. */
function toPieces(text: string, max: number): string[] {
  return text.split("\n").flatMap((line) => {
    const parts: string[] = [];
    for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
    return parts.length ? parts : [""];
  });
}

/**
 * Split text into chunks <= max chars on line boundaries.
 * A ``` fence left open at a chunk end is closed and reopened in the next chunk.
 */
export function splitChunks(text: string, max = CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let cur: string[] = []; // lines of the chunk being built
  let len = 0;
  let inFence = false; // inside a ``` block at the current position
  for (const line of toPieces(text, max)) {
    // +1 for the newline. Fence markers added at edges (<=8 chars) fit in the slack below Discord's 2000.
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
  if (safe.length > REPLY_CAP) safe = safe.slice(0, REPLY_CAP) + "\n\n[output truncated]";
  // Discord rejects empty messages: drop blank chunks, fall back to a notice.
  const chunks = splitChunks(safe).filter((c) => c.trim() !== "");
  return chunks.length ? chunks : ["(no answer)"];
}

/** A reply sent as a head message plus one redacted file. */
export interface OutputFile {
  name: "reply.md" | "changes.diff";
  content: string;
}

/** True when ```diff blocks make up more than half of the text. */
function isMainlyDiff(text: string): boolean {
  let inDiff = 0;
  for (const [block] of text.matchAll(/```diff\n[\s\S]*?(?:```|$)/g)) inDiff += block.length;
  return inDiff > text.length / 2;
}

/** `text` with an open ``` fence closed (a cut text must not swallow the rest of the message). */
function closeFence(text: string): string {
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
 * What to send for a reply, redacted: chat bubbles (one per paragraph, at most MAX_BUBBLES) plus an optional file.
 * - text after a `---` line, or a long / table / long-code reply: bubbles = the chat part (or the first paragraph) and
 *   the full text as `reply.md`;
 * - mainly a diff: a head + `changes.diff`;
 * - otherwise bubbles only.
 */
export function prepareOutput(
  text: string,
  language: OwnerLanguage,
): { bubbles: string[]; file?: OutputFile } {
  const safe = redactText(text);
  if (isMainlyDiff(safe))
    return { bubbles: [headOf(safe, language)], file: { name: "changes.diff", content: safe } };
  const { chat, detail, split } = splitReply(safe);
  const asFile = (chatText: string, content: string) => {
    // No chat part to show: fall back to the first paragraph. Either way the chat part is cut at HEAD_MAX, so it
    // stays within MAX_BUBBLES messages of at most CHUNK_MAX chars (and an open fence is closed).
    const head = closeFence(clip(chatText || (paragraphs(content)[0] ?? ""), HEAD_MAX));
    return { bubbles: bubblesOf(head), file: { name: "reply.md" as const, content } };
  };
  if (split && detail) return asFile(chat, `${chat}\n\n${detail}`.trim());
  // Without a usable `---`, a long reply shows only its first paragraph; the rest is in the file.
  if (needsFile(safe)) return asFile(split ? chat : "", split ? chat : safe);
  return { bubbles: bubblesOf(chat) };
}

/** A link offered as a Discord link button. */
export interface ReportLink {
  label: string;
  url: string;
}

/** Discord allows 5 buttons per row; reports offer at most three links. */
const LINKS_MAX = 3;
/** Discord caps a button label at 80 chars. */
const LINK_LABEL_MAX = 80;

/** Discord rejects the whole message when a link button URL is over 512 chars. */
const LINK_URL_MAX = 512;

/** Normalized absolute http(s) URL of at most 512 chars, or undefined (local paths, `file:`, relative, `javascript:`, ...). */
function safeUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const ok = u.protocol === "http:" || u.protocol === "https:";
    return ok && u.href.length <= LINK_URL_MAX ? u.href : undefined;
  } catch {
    return undefined; // relative paths and bare text do not parse as absolute URLs
  }
}

/** Keep only safe absolute links (deduped by URL, max three); a blank label falls back to the host. */
export function safeLinks(links: ReportLink[]): ReportLink[] {
  const out: ReportLink[] = [];
  for (const link of links) {
    const url = safeUrl(link.url.trim());
    if (!url || out.some((l) => l.url === url)) continue;
    const label = clip(link.label.trim() || new URL(url).host, LINK_LABEL_MAX);
    out.push({ label, url });
    if (out.length === LINKS_MAX) break;
  }
  return out;
}

/** Safe `[label](url)` links found in Markdown text; code is not special-cased (a link in a fence is still a link). */
export function markdownLinks(markdown: string): ReportLink[] {
  const found = [...markdown.matchAll(/(!?)\[([^\]\n]+)\]\((\S+?)\)/g)]
    .filter((m) => !m[1]) // `![alt](url)` is an image, not a link
    .map((m) => ({ label: m[2]!, url: m[3]! }));
  return safeLinks(found);
}
