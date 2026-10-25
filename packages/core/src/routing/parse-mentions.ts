import type { Bot, BotId } from "../domain/bot";

/** A character that continues a name: a mention must not stop in the middle of a word. */
const WORD = /[\p{L}\p{M}\p{N}_-]/u;

/**
 * Members mentioned by `@name` in `text`: case-insensitive, each bot once, in text order. A name is the bot's
 * display name (spaces and accents allowed); the longest member name that follows the `@` and ends at a word
 * boundary wins, so `@Nhà phân tích` is that bot even when a bot `Nhà` exists. An `@` glued to a word before it
 * (an e-mail address) is not a mention; a name that is not a member is ignored.
 */
export function parseMentions(text: string, members: Bot[]): BotId[] {
  const t = text.normalize("NFC");
  const byLength = members
    .map((b) => ({ id: b.id, name: b.name.normalize("NFC").toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  const found: BotId[] = [];
  for (let i = t.indexOf("@"); i >= 0; i = t.indexOf("@", i + 1)) {
    const before = t[i - 1];
    if (before && (WORD.test(before) || before === "@")) continue;
    const rest = t.slice(i + 1);
    const hit = byLength.find(
      (b) =>
        rest.slice(0, b.name.length).toLowerCase() === b.name &&
        !WORD.test(rest[b.name.length] ?? ""),
    );
    if (hit && !found.includes(hit.id)) found.push(hit.id);
  }
  return found;
}
