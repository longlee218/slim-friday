import type { Bot, BotId } from "../domain/bot";

/**
 * Members mentioned by `@name` in `text`: case-insensitive, whole word, each bot once, in text order.
 * An `@` glued to a word before it (an e-mail address) is not a mention; a name that is not a member is ignored.
 */
export function parseMentions(text: string, members: Bot[]): BotId[] {
  const byName = new Map(members.map((b) => [b.name.toLowerCase(), b.id]));
  const found: BotId[] = [];
  for (const m of text.matchAll(/(?<![\w@])@([\w-]+)/g)) {
    const id = byName.get((m[1] ?? "").toLowerCase());
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}
