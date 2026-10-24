import type { Conversation } from "../domain/conversation";
import type { Log } from "../ports/log";
import type { Memory, MemoryOwner } from "../ports/memory";
import type { PoolEntry } from "./session-pool";

/**
 * The owner's memory as a prompt gets it: cut to `maxChars` when the adapter can (else read whole). A file over twice
 * the cap logs `memory.large`, so the owner knows to prune. A failed read gives "".
 */
export async function promptMemory(
  memory: Memory | undefined,
  owner: MemoryOwner,
  maxChars: number,
  log?: Log,
): Promise<string> {
  if (!memory) return "";
  try {
    if (!memory.readForPrompt) return await memory.read(owner);
    const r = await memory.readForPrompt(owner, maxChars);
    if (r.chars > 2 * maxChars)
      log?.warn({ owner, chars: r.chars, hidden: r.hidden }, "memory.large");
    return r.text;
  } catch {
    return "";
  }
}

/**
 * The group memory to send with a turn: the text when the conversation is a group one and the
 * text (capped at `maxChars`) differs from what this session last got, else undefined. A failed read sends nothing.
 */
export async function changedGroupMemory(
  entry: PoolEntry,
  conv: Conversation,
  memory: Memory | undefined,
  maxChars: number,
  log?: Log,
): Promise<string | undefined> {
  if (!memory || conv.kind !== "group") return undefined;
  const text = await promptMemory(memory, { kind: "group", groupId: conv.groupId }, maxChars, log);
  if (!text.trim()) return undefined;
  if (entry.groupMemorySent.get(conv.groupId) === text) return undefined;
  entry.groupMemorySent.set(conv.groupId, text);
  return text;
}
