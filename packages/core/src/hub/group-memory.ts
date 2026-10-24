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
 * The group memory of a group session (capped at `maxChars`), undefined when empty or unreadable. Read at
 * every session open into the system prompt.
 */
export async function groupMemoryFor(
  groupId: string,
  memory: Memory | undefined,
  maxChars: number,
  log?: Log,
): Promise<string | undefined> {
  if (!memory) return undefined;
  const text = await promptMemory(memory, { kind: "group", groupId }, maxChars, log);
  return text.trim() ? text : undefined;
}
