import type { GroupDto } from "@friday/contracts";
import { ROUTE_SUFFIX, type RouteInfo } from "./route-info";

/** A character that continues a name; the same rule as the engine's `parseMentions`. */
const WORD = /[\p{L}\p{M}\p{N}_-]/u;
/** The word being typed after an `@`, right before the caret. */
const QUERY = /@([\p{L}\p{M}\p{N}_-]*)$/u;

/** The partial `@name` right before the caret, lower-cased; null when the caret is not in one. */
export function mentionQuery(text: string, caret: number): string | null {
  const m = text.slice(0, caret).match(QUERY);
  return m ? (m[1] ?? "").toLowerCase() : null;
}

/**
 * Where each `@name` of one of `names` sits in `text` (`end` is after the name). Names are display
 * names (spaces, accents); the longest name after the `@` that ends at a word boundary wins, and an
 * `@` glued to a word (an e-mail address) is skipped. Mirrors the engine's `parseMentions`.
 */
export function mentionSpans(text: string, names: string[]): { start: number; end: number }[] {
  const byLength = names.map((n) => n.toLowerCase()).sort((a, b) => b.length - a.length);
  const spans: { start: number; end: number }[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    const before = text[i - 1];
    if (before && (WORD.test(before) || before === "@")) continue;
    const rest = text.slice(i + 1);
    const hit = byLength.find(
      (n) => rest.slice(0, n.length).toLowerCase() === n && !WORD.test(rest[n.length] ?? ""),
    );
    if (hit) spans.push({ start: i, end: i + 1 + hit.length });
  }
  return spans;
}

/** Ids of the members named with `@name` in the text: case-insensitive, unique, in order. */
export function mentioned(text: string, members: { id: string; name: string }[]): string[] {
  const ids: string[] = [];
  for (const { start, end } of mentionSpans(
    text,
    members.map((b) => b.name),
  )) {
    const name = text.slice(start + 1, end).toLowerCase();
    const hit = members.find((b) => b.name.toLowerCase() === name);
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
