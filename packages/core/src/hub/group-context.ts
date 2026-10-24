import type { Group } from "../domain/group";
import { type ProjectRulesReader, renderGroupContext } from "../routing/group-context";

/**
 * The group context of a group session (instructions, working dirs, project rules), undefined when empty.
 * Read at every session open into the system prompt. Rules are read from the group's first workspace; a
 * reader that throws counts as no rules.
 */
export async function groupContextFor(
  group: Group,
  read?: ProjectRulesReader,
): Promise<string | undefined> {
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
