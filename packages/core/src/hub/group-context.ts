import type { Conversation } from "../domain/conversation";
import type { Group } from "../domain/group";
import { type ProjectRulesReader, renderGroupContext } from "../routing/group-context";

/**
 * The group context for a turn: the text when the conversation is a group one and the text is not empty, else
 * undefined. Loaded fresh for every run (a run opens its own session). Rules are read from the group's first
 * workspace; a reader that throws counts as no rules.
 */
export async function groupContextFor(
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
  return renderGroupContext(group, rules) || undefined;
}
