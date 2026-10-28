/** Everything that decides what text may reach a `cua` argv or a guest shell line. */

/** A computer name: lowercase letters, digits and `-`, 1 to 32 chars, never a path or a flag. */
export const COMPUTER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Return `name` when it is a valid computer name; throw before anything runs otherwise. */
export function assertComputerName(name: string): string {
  if (typeof name !== "string" || !COMPUTER_NAME.test(name))
    throw new Error("computer name must match [a-z0-9][a-z0-9-]{0,31}");
  return name;
}

/** An env variable name safe to put in front of a guest command. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** POSIX single-quote one word: the shell reads back exactly `s`, whatever it holds. */
export function shellQuote(s: string): string {
  if (s.includes("\0")) throw new Error("shell word must not contain a NUL byte");
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** One shell line from an argv: every word quoted, joined by spaces. */
export function shellLine(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
