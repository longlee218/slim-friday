import type { Conversation } from "../domain/conversation";
import type { Group } from "../domain/group";
import { type ProjectRulesReader, renderGroupContext } from "../routing/group-context";
import type { PoolEntry } from "./session-pool";

/**
 * The group context to send with a turn: the text when the conversation is a group one, the text is not
 * empty and differs from what this session last got, else undefined. Rules are read from the group's first
 * workspace on every group turn; a reader that throws counts as no rules.
 */
export async function changedGroupContext(
  entry: PoolEntry,
  conv: Conversation,
  group: Group | undefined,
  read?: ProjectRulesReader,
): Promise<string | undefined> {
  if (conv.kind !== "group" || !group) return undefined;
  const [main] = group.workspaces;
  let rules: Awaited<ReturnType<ProjectRulesReader>>;
  if (read && main !== undefined) {
    try {
      rules = await read(main);
    } catch {
      rules = undefined;
    }
  }
  const text = renderGroupContext(group, rules);
  if (!text) return undefined;
  if (entry.groupContextSent.get(conv.groupId) === text) return undefined;
  entry.groupContextSent.set(conv.groupId, text);
  return text;
}
