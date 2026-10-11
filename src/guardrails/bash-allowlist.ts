/**
 * The repo's test command (`allowedCommands`) may run exactly as configured, and with extra PLAIN arguments after it
 * (`bun test` also allows `bun test src/a.test.ts -t name`): a subagent has no owner to ask, so a focused test run
 * that is not byte-identical to the configured command would otherwise be a deny and stall the loop.
 * Extra arguments are a FLAG ALLOWLIST (-t/--test-name-pattern, --bail, --timeout, --rerun-each, --update-snapshots,
 * --coverage, --no-coverage, --only, --todo) with simple values, plus plain relative positionals; any other flag is
 * not allowlisted and falls to the normal ask (a subagent: deny).
 * Everything else about the line (shell expansion, redirects, other segments) is still judged by `bash-policy.ts`.
 */
import { parseCommand } from "./bash-parser";

/** Words of one simple command (a single segment), or null when it is not one or cannot be parsed. */
export function commandWords(command: string): string[] | null {
  try {
    const segs = parseCommand(command);
    return segs.length === 1 ? (segs[0]?.words ?? null) : null;
  } catch {
    return null;
  }
}

/** Word lists of the allowlisted commands (the ones that are not a single simple command are dropped). */
export const allowlistWords = (commands: string[] | undefined): string[][] =>
  (commands ?? []).flatMap((c) => {
    const w = commandWords(c);
    return w ? [w] : [];
  });

/** Watch, hot reload and inspector modes never end or open a port: never allowed (also not by the flag allowlist). */
const WATCH = /^(--watch(-?all)?|--hot|--inspect(-brk|-wait)?(=.*)?|-w)$/i;

/** A flag value: plain text only (no path, no shell metacharacter, no newline). */
const simpleValue = (v: string): boolean => /^[A-Za-z0-9_ .:-]{1,100}$/.test(v);

/** Test-runner flags that take a value (`--f=v` or `--f v`), and flags that stand alone or take only `=N`. */
const VALUE_FLAGS = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each"]);
const BARE_FLAGS = new Set([
  "--update-snapshots",
  "--coverage",
  "--no-coverage",
  "--only",
  "--todo",
]);

/** A positional: a plain relative test path or name filter; no absolute, `~`, `$`, `..`, dot-directory or leading dash. */
const plainPositional = (a: string): boolean =>
  /^[\w@+%,.:/-]+$/.test(a) &&
  !a.startsWith("/") &&
  !a.split("/").some((seg) => seg === ".." || (seg.startsWith(".") && seg !== "."));

/** The extra arguments after the allowlisted command: only the flags above, simple values, plain positionals. */
function plainArgs(args: string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (WATCH.test(a)) return false;
    if (!a.startsWith("-")) {
      if (!plainPositional(a)) return false;
      continue;
    }
    const [flag, ...rest] = a.split("=");
    const eq = rest.length ? rest.join("=") : undefined;
    if (flag === "--bail" && (eq === undefined || /^\d{1,4}$/.test(eq))) continue;
    if (BARE_FLAGS.has(flag as string) && eq === undefined) continue;
    if (VALUE_FLAGS.has(flag as string)) {
      const v = eq ?? args[++k];
      if (v === undefined || !simpleValue(v)) return false;
      continue;
    }
    return false; // every other flag: not allowlisted
  }
  return true;
}

/** True when `words` are exactly one of the allowlisted commands (`prefixes`, as word lists) plus only plain arguments. */
export function extendsAllowed(words: string[], prefixes: string[][]): boolean {
  return prefixes.some(
    (p) =>
      p.length > 0 &&
      words.length >= p.length &&
      p.every((w, k) => words[k] === w) &&
      plainArgs(words.slice(p.length)),
  );
}
