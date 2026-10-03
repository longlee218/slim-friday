import { redactText } from "../observability/redact";

/** Mention policy for every outgoing message: nothing can ping (@everyone, @here, roles, users). */
export const SAFE_MENTIONS = { parse: [] as never[], repliedUser: false };

/** Discord hard limit is 2000; stay under it. */
export const CHUNK_MAX = 1900;
/** Replies longer than this are truncated (attachments come in Phase 5). */
export const REPLY_CAP = 6000;
/** Max Discord thread name length is 100; keep it shorter. */
const THREAD_NAME_MAX = 90;

/** Minimal message facts the routing rules need (decoupled from discord.js types). */
export interface MessageFacts {
  authorId: string;
  authorIsBot: boolean;
  /** False for DMs. */
  inGuild: boolean;
  /** True when the channel is a thread created by this bot. */
  inBotThread: boolean;
  /** True when the message mentions this bot. */
  mentionsBot: boolean;
  content: string;
}

/** Routing decision for one message. */
export type Route =
  | { kind: "ignore" }
  /** Continue the session of the thread the message is in. */
  | { kind: "thread"; prompt: string }
  /** New conversation: create a thread from the message. */
  | { kind: "channel"; prompt: string };

/** Remove the bot mention (`<@id>` / `<@!id>`) and trim. */
export function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** True when the whole message is `stop` (case-insensitive), the cancel command. */
export function isStop(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "stop";
}

/** Decide what to do with a message. Non-owners and bots never get past `ignore`. */
export function routeMessage(f: MessageFacts, ownerId: string, botId: string): Route {
  if (f.authorIsBot || f.authorId !== ownerId || !f.inGuild) return { kind: "ignore" };
  const prompt = stripMention(f.content, botId);
  if (!prompt) return { kind: "ignore" };
  if (f.inBotThread) return { kind: "thread", prompt };
  // Outside a bot thread the owner must mention the bot explicitly.
  if (f.mentionsBot) return { kind: "channel", prompt };
  return { kind: "ignore" };
}

/** Thread title from the first words of the prompt, single line, <=90 chars. */
export function threadName(prompt: string): string {
  // Redact first so a pasted secret never becomes a channel-visible title.
  const flat = redactText(prompt).replace(/\s+/g, " ").trim();
  return (
    (flat.length > THREAD_NAME_MAX ? flat.slice(0, THREAD_NAME_MAX - 1).trimEnd() + "…" : flat) ||
    "chat"
  );
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
