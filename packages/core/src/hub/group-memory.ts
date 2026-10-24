import type { Conversation } from "../domain/conversation";
import type { Memory } from "../ports/memory";
import type { PoolEntry } from "./session-pool";

/**
 * The group memory to send with a turn: the text when the conversation is a group one and the
 * text differs from what this session last got, else undefined. A failed read sends nothing.
 */
export async function changedGroupMemory(
  entry: PoolEntry,
  conv: Conversation,
  memory: Memory | undefined,
): Promise<string | undefined> {
  if (!memory || conv.kind !== "group") return undefined;
  const text = await memory.read({ kind: "group", groupId: conv.groupId }).catch(() => undefined);
  if (text === undefined || !text.trim()) return undefined;
  if (entry.groupMemorySent.get(conv.groupId) === text) return undefined;
  entry.groupMemorySent.set(conv.groupId, text);
  return text;
}
