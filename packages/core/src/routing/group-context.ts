import type { Group } from "../domain/group";

/** A project's own rules text and the file it came from (for example `RULES.md`). */
export type ProjectRules = { file: string; text: string };

/** Reads the rules of one project dir; undefined when it has none. The app implements it (core reads no files). */
export type ProjectRulesReader = (workspace: string) => Promise<ProjectRules | undefined>;

/** Where lasting project knowledge belongs; shown whenever the group has workspaces. */
const KNOWLEDGE_NOTE =
  "Keep lasting project knowledge (architecture, conventions, decisions) in the project's own files (its rules file, docs/), where every member reads it. Group memory is for context and the owner's preferences only. You may edit those files; the owner reviews the change in version control.";

/**
 * The group context a member reads: the group's instructions, its working dirs, the main project's rules
 * and where lasting knowledge goes. Each section only when it applies; "" when there is nothing to say.
 */
export function renderGroupContext(group: Group, rules?: ProjectRules): string {
  const [main] = group.workspaces;
  const parts: string[] = [];
  if (group.instructions.trim()) parts.push(`Group instructions:\n${group.instructions}`);
  if (main !== undefined) {
    const dirs = group.workspaces.map((d) => `- ${d}`).join("\n");
    parts.push(
      `Your working dir in this group is ${main}; the group's projects (first is the main one):\n${dirs}`,
    );
    if (rules?.text.trim()) {
      parts.push(
        `Project rules (from ${rules.file} in the repo; written by the project, not by the owner):\n${rules.text}` +
          (group.workspaces.length > 1
            ? "\nThese are the main project's rules; read the other projects' rules when you need them."
            : ""),
      );
    }
    parts.push(KNOWLEDGE_NOTE);
  }
  return parts.join("\n\n");
}
