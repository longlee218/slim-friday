/**
 * Old role names that stored rows may still carry (no schema change: rows are never rewritten). Data, not code:
 * a renamed role adds one entry here. Every place that reads a stored role name goes through `canonicalRoleName`.
 */
const ROLE_ALIASES: Readonly<Record<string, string>> = { dev: "developer" };

/** Current role name for a stored or typed one (an unknown name passes through unchanged). */
export const canonicalRoleName = (name: string): string =>
  Object.hasOwn(ROLE_ALIASES, name) ? (ROLE_ALIASES[name] as string) : name;
