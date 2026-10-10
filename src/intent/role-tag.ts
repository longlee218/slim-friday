import type { RoleDefinition } from "../roles/role-types";

/** The part of a role the tag router needs. */
type TagRole = Pick<RoleDefinition, "name" | "tag">;

/** A leading role tag found in a message: the role it names and the text after the tag. */
export interface TagMatch {
  role: string;
  rest: string;
}

/** L1: the explicit role tag at the very start of the message (no natural-language matching anywhere). */
export interface RoleTagRouter {
  route(text: string): TagMatch | undefined;
}

/** Tag shape: one bracketed word, e.g. `[dev]`. */
const TAG_SHAPE = /^\[[a-z0-9_-]+\]$/;

/** Longest-first match of a leading tag (case-insensitive, leading space ignored); undefined when none. */
function leading(text: string, tags: { tag: string; role: string }[]): TagMatch | undefined {
  const head = text.normalize("NFC").trimStart();
  const hit = tags.find((t) => head.toLowerCase().startsWith(t.tag));
  return hit ? { role: hit.role, rest: head.slice(hit.tag.length).trim() } : undefined;
}

/** Lowercased tags of the roles that have one. */
const tagsOf = (roles: readonly TagRole[]) =>
  roles.flatMap((r) => (r.tag ? [{ tag: r.tag.toLowerCase(), role: r.name }] : []));

/** Role tag at the start of `text`, or undefined (used to strip the tag from the brief). */
export const leadingRoleTag = (text: string, roles: readonly TagRole[]): TagMatch | undefined =>
  leading(text, tagsOf(roles));

/**
 * Build the L1 router from role data. Registry validation, throws (startup refusal) when a tag is malformed or
 * two roles use the same tag (case-insensitive).
 */
export function createRoleTagRouter(roles: readonly TagRole[]): RoleTagRouter {
  const tags = tagsOf(roles);
  const owner = new Map<string, string>();
  for (const t of tags) {
    if (!TAG_SHAPE.test(t.tag)) throw new Error(`Role ${t.role}: invalid role tag "${t.tag}"`);
    const by = owner.get(t.tag);
    if (by) throw new Error(`Role tag ${t.tag} is used by roles ${by} and ${t.role}`);
    owner.set(t.tag, t.role);
  }
  return { route: (text) => leading(text, tags) };
}
