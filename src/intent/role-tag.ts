import { aliasesOf } from "../roles/role-aliases";
import type { RoleDefinition } from "../roles/role-types";

/** The part of a role the tag router needs. */
type TagRole = Pick<RoleDefinition, "name" | "tag">;

/** A leading role tag found in a message: the role it names and the text after the tag. */
export interface TagMatch {
  role: string;
  rest: string;
}

/** Longest-first match of a leading tag (case-insensitive, leading space ignored); undefined when none. */
function leading(text: string, tags: { tag: string; role: string }[]): TagMatch | undefined {
  const head = text.normalize("NFC").trimStart();
  const hit = tags.find((t) => head.toLowerCase().startsWith(t.tag));
  return hit ? { role: hit.role, rest: head.slice(hit.tag.length).trim() } : undefined;
}

/** Lowercased tags of the roles that have one, plus `[old-name]` for each old name of a role. */
const tagsOf = (roles: readonly TagRole[]) =>
  roles.flatMap((r) =>
    r.tag
      ? [r.tag, ...aliasesOf(r.name).map((a) => `[${a}]`)].map((tag) => ({
          tag: tag.toLowerCase(),
          role: r.name,
        }))
      : [],
  );

/** Role tag at the start of `text`, or undefined (used to strip the tag from the brief). */
export const leadingRoleTag = (text: string, roles: readonly TagRole[]): TagMatch | undefined =>
  leading(text, tagsOf(roles));
