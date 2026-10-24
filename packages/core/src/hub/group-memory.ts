import type { Conversation } from "../domain/conversation";
import type { Log } from "../ports/log";
import type { Memory, MemoryOwner } from "../ports/memory";

/**
 * The owner's memory as a prompt gets it: cut to `maxChars` when the adapter can (else read whole), only notes of
 * `kinds` when given (an adapter that cannot filter gives nothing then). A file over twice the cap logs
 * `memory.large`, so the owner knows to prune. A failed read gives "".
 */
export async function promptMemory(
  memory: Memory | undefined,
  owner: MemoryOwner,
  maxChars: number,
  log?: Log,
  kinds?: readonly string[],
): Promise<string> {
  if (!memory) return "";
  try {
    if (!memory.readForPrompt) return kinds ? "" : await memory.read(owner);
    const r = await memory.readForPrompt(owner, maxChars, kinds);
    if (r.chars > 2 * maxChars)
      log?.warn({ owner, chars: r.chars, hidden: r.hidden }, "memory.large");
    return r.text;
  } catch {
    return "";
  }
}

/**
 * The group memory for a turn: the text (capped at `maxChars`) when the conversation is a group one and the memory
 * is not empty, else undefined. Loaded fresh for every run. A failed read sends nothing.
 */
export async function groupMemoryFor(
  conv: Conversation,
  memory: Memory | undefined,
  maxChars: number,
  log?: Log,
): Promise<string | undefined> {
  if (!memory || conv.kind !== "group") return undefined;
  const text = await promptMemory(memory, { kind: "group", groupId: conv.groupId }, maxChars, log);
  return text.trim() ? text : undefined;
}
