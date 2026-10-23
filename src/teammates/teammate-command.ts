import type { TeammateEdit } from "./teammate-admin";

/* Text grammar of `/teammate` (the slash layer hands over one string, like every command):
     create <space> <name> [model]
     list
     edit <name> <field> <value...>      field: title | instructions | description | model | tools | skills
     archive <name>
   `tools` and `skills` take a comma list; every other value is the rest of the line, kept as typed. */

/** A parsed `/teammate` command. */
export type TeammateCommand =
  | { kind: "create"; space: string; name: string; model?: string }
  | { kind: "list" }
  | { kind: "edit"; name: string; edit: TeammateEdit }
  | { kind: "archive"; name: string };

/** Usage text, also the reply to an unreadable command. */
export const TEAMMATE_USAGE = [
  "`/teammate create <space> <name> [model]`",
  "`/teammate list`",
  "`/teammate edit <name> <title|instructions|description|model|tools|skills> <value>`",
  "`/teammate archive <name>`",
].join("\n");

const FIELDS = ["title", "instructions", "description", "model", "tools", "skills"] as const;

/** `a, b ,c` -> `["a","b","c"]` (empty items dropped). */
const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Parse the argument text of `/teammate`; undefined when it does not match the grammar. */
export function parseTeammateCommand(text: string): TeammateCommand | undefined {
  const [verb = "", ...rest] = text.trim().split(/\s+/);
  if (verb === "list" && !rest.length) return { kind: "list" };
  if (verb === "archive" && rest.length === 1 && rest[0]) return { kind: "archive", name: rest[0] };
  if (verb === "create" && (rest.length === 2 || rest.length === 3) && rest[0] && rest[1])
    return { kind: "create", space: rest[0], name: rest[1], ...(rest[2] && { model: rest[2] }) };
  if (verb === "edit") {
    const m = /^\s*edit\s+(\S+)\s+(\S+)\s+([\s\S]+?)\s*$/.exec(text);
    const field = FIELDS.find((f) => f === m?.[2]);
    if (!m?.[1] || !field || !m[3]) return undefined;
    const value = m[3];
    const edit: TeammateEdit =
      field === "tools" || field === "skills" ? { [field]: csv(value) } : { [field]: value };
    return { kind: "edit", name: m[1], edit };
  }
  return undefined;
}
