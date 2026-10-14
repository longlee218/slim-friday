import { isAdminText } from "../discord-setup/admin-command";
import { redactText } from "../observability/redact";

/** Mention policy for every outgoing message: nothing can ping (@everyone, @here, roles, users). */
export const SAFE_MENTIONS = { parse: [] as never[], repliedUser: false };

/** Discord hard limit is 2000; stay under it. */
export const CHUNK_MAX = 1900;
/** Replies longer than this are truncated. */
export const REPLY_CAP = 6000;
/** Replies longer than this, or mainly a diff, go out as an attachment with a short head. */
export const ATTACH_MIN = 6000;
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
  /** Admin text (control channel, or `init:workspace:` typed anywhere): handled by the admin gate, never by the agent. */
  | { kind: "control"; prompt: string }
  /** Continue the session of the thread the message is in. */
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
  const inThread = f.inBotThread || !!f.adoptedThread; // bot-owned or adopted: no mention needed
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

/** First ~HEAD_MAX chars, cut on a line boundary, with an open ``` fence closed. */
function headOf(text: string): string {
  const cut = text.slice(0, HEAD_MAX);
  const head = cut.length < text.length ? cut.slice(0, Math.max(cut.lastIndexOf("\n"), 1)) : cut;
  const open = (head.match(/^\s*```/gm) ?? []).length % 2 === 1;
  return `${head}${open ? "\n```" : ""}\n\n[full reply attached]`;
}

/**
 * What to send for a reply: chunks, plus a file when the reply is long (> ATTACH_MIN) or mainly a diff
 * (head + `changes.diff` / `reply.md`). Everything is redacted, including the file content.
 */
export function prepareOutput(text: string): { chunks: string[]; file?: OutputFile } {
  const safe = redactText(text);
  const diff = isMainlyDiff(safe);
  if (safe.length <= ATTACH_MIN && !diff) return { chunks: prepareReply(safe) };
  return {
    chunks: [headOf(safe)],
    file: { name: diff ? "changes.diff" : "reply.md", content: safe },
  };
}
