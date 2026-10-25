/** Longest id the contract accepts (`BotIdSchema`). */
const MAX = 32;

/**
 * The file id of a new bot or group, made from its display name: accents dropped (`đ` is `d`),
 * lowercase, words joined by dashes, starting with a letter, at most 32 characters, and `-2`,
 * `-3`... when it is taken. `fallback` is used when the name has no letter at all.
 */
export function autoId(name: string, taken: Iterable<string>, fallback: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .slice(0, MAX)
      .replace(/-+$/, "") || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(id)) return id;
  }
}
