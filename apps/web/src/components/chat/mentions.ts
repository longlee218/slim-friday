import type { GroupDto } from "@friday/contracts";
import { ROUTE_SUFFIX, type RouteInfo } from "./route-info";

/** `\w` limits names to ASCII letters, digits and `_` (known limit; matches the prototype). */
const QUERY = /@(\w*)$/;

/** The partial `@name` right before the caret, lower-cased; null when the caret is not in one. */
export function mentionQuery(text: string, caret: number): string | null {
  const m = text.slice(0, caret).match(QUERY);
  return m ? (m[1] ?? "").toLowerCase() : null;
}

/** Ids of the members named with `@name` in the text: case-insensitive, unique, in order. */
export function mentioned(text: string, members: { id: string; name: string }[]): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/@(\w+)/g)) {
    const hit = members.find((b) => b.name.toLowerCase() === (m[1] ?? "").toLowerCase());
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/** Replaces the `@query` before the caret with `@Name ` and returns the new caret. */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret).replace(QUERY, `@${name} `);
  return { text: before + text.slice(caret), caret: before.length };
}

/** Who a group message goes to: named members, else the replied-to bot, else the entry bot. */
export function routeOf(s: {
  text: string;
  replyToBotId?: string;
  group: GroupDto;
  names: Map<string, string>;
}): RouteInfo {
  const members = s.group.members.map((id) => ({ id, name: s.names.get(id) ?? id }));
  const named = mentioned(s.text, members);
  if (named.length) return { botIds: named, reason: "named" };
  if (s.replyToBotId) return { botIds: [s.replyToBotId], reason: "reply" };
  return { botIds: [s.group.entryBot], reason: "entry" };
}

/** The composer's route: a group routes by `routeOf`, a direct chat goes to its bot. */
export function composerRoute(s: {
  text: string;
  replyToBotId?: string;
  group?: GroupDto;
  botId?: string;
  names: Map<string, string>;
}): RouteInfo | null {
  if (s.group) return routeOf({ ...s, group: s.group });
  return s.botId ? { botIds: [s.botId], reason: "direct" } : null;
}

/** The chip copy: "To Pia · entry", "To Tess, Dev", "To Dev · reply". */
export function routeChipText(r: RouteInfo, names: Map<string, string>): string {
  return `To ${r.botIds.map((id) => names.get(id) ?? id).join(", ")}${ROUTE_SUFFIX[r.reason]}`;
}
