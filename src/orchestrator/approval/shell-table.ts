import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFallbackDefault } from "./check-envelope";
import type { RiskClass } from "./risk-types";

/* The worker shell table (config/data/worker-bash-allowlist.yaml) and the exact-flag matcher. A flag that is not listed is
   unknown: there is no pass-through, no abbreviation, no attached value, no guessing. Pure. */

/** One table entry (a `sub` entry overrides the command's own fields). */
export interface Entry {
  class?: RiskClass;
  /** Where the cwd and the path operands must lie: granted read dirs, write dirs, or nowhere (no file access). */
  fs?: "read" | "write" | "none";
  /** Exact flags: `-x`, `--long` (no value) or `-x:kind` / `--long:kind` (a value); `-NUM` = a count like -20. */
  flags?: string[];
  /** `-la` is allowed when every letter is a listed no-value short flag. */
  cluster?: boolean;
  /** `ref`: at most one branch name (checkout / switch). `delref`: exactly one non-default branch name. `worktree`: `<dir> <branch>`. `plain`: one word without `:` or `/`. */
  operands?:
    | "none"
    | "path"
    | "pattern"
    | "sed"
    | "script"
    | "word"
    | "plain"
    | "ref"
    | "delref"
    | "worktree"
    | "any";
  /** Flags that must be present. */
  require?: string[];
  /** Most operands allowed (`uniq in` only: a second operand would be its OUTPUT file). Default 20. */
  max?: number;
  /** Effect tool that replaces the command. */
  use?: string;
  sub?: Record<string, Entry>;
}

/** The parsed table. */
const TABLE = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../../config/data/worker-bash-allowlist.yaml"), "utf8"),
) as { commands: Record<string, Entry> };

/** Value shapes of a flag: a count, a plain word, a branch name, a commit message word (never a path unless `path`). */
const KINDS: Record<string, RegExp> = {
  num: /^\d{1,6}$/,
  word: /^[A-Za-z0-9][A-Za-z0-9_.:@%+,/-]{0,99}$/,
  ref: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/,
  msg: /^[^-]/,
  plain: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,
};
/** A `ref` value must also be a clean git name. */
const cleanRef = (v: string): boolean =>
  !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".lock");
/** True when `v` is a clean git branch name. */
const refOk = (v: string): boolean => KINDS.ref.test(v) && cleanRef(v);
/** Flags after which the first operand is NOT a search pattern (it is already a path). */
const NO_PATTERN = new Set(["-e", "--files"]);
/** Most operands a line may carry unless the entry says less. */
const MAX_OPERANDS = 20;

/** A matched command: its effective entry and the words after the command / subcommand. */
export interface Matched {
  entry: Entry;
  rest: string[];
}

/** Find the entry of a command line: the command, then (when it has `sub`) a listed one- or two-word subcommand. */
export function matchCommand(words: string[]): Matched | undefined {
  const top = Object.hasOwn(TABLE.commands, words[0]) ? TABLE.commands[words[0]] : undefined;
  if (!top) return undefined;
  const { sub, ...base } = top;
  if (!sub) return { entry: base, rest: words.slice(1) };
  // A flag before the subcommand (`git -C`, `-c`, `--git-dir`) is never listed: the line is unknown.
  if (!words[1] || words[1].startsWith("-")) return undefined;
  for (const n of [2, 1]) {
    const key = words.slice(1, 1 + n).join(" ");
    if (words.length >= 1 + n && Object.hasOwn(sub, key))
      return { entry: { ...base, ...sub[key] }, rest: words.slice(1 + n) };
  }
  return undefined;
}

/** True when the value `v` fits flag kind `kind`; a `path` value is returned to the caller as an operand. */
function valueOk(kind: string, v: string | undefined): boolean {
  if (v === undefined) return false;
  if (kind === "path") return !v.startsWith("-");
  return (KINDS[kind]?.test(v) ?? false) && (kind !== "ref" || cleanRef(v));
}

/**
 * Check the arguments of a matched command against its exact flag set. Returns the path operands to resolve, or undefined
 * when anything is not listed (unknown flag, attached short value, wrong value, wrong operand shape, missing `require`).
 */
export function checkArgs(entry: Entry, rest: string[]): string[] | undefined {
  const spec = new Map<string, string | null>();
  for (const f of entry.flags ?? []) {
    const at = f.indexOf(":", 1);
    spec.set(at < 0 ? f : f.slice(0, at), at < 0 ? null : f.slice(at + 1));
  }
  const operands: string[] = [];
  const seen = new Set<string>();
  const paths: string[] = [];
  let dashes = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (dashes || !a.startsWith("-") || a === "-") operands.push(a);
    else if (a === "--") dashes = true;
    else if (/^-\d{1,4}$/.test(a) && spec.has("-NUM")) continue;
    else {
      const long = a.startsWith("--");
      const name = long && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (spec.has(name)) {
        const kind = spec.get(name);
        seen.add(name);
        if (kind === null || kind === undefined) {
          if (name !== a) return undefined; // a value glued to a flag that takes none
        } else {
          const v = name !== a ? a.slice(name.length + 1) : rest[++i];
          if (!valueOk(kind, v)) return undefined;
          if (kind === "path") paths.push(v as string);
        }
      } else if (
        entry.cluster &&
        /^-[A-Za-z]{2,}$/.test(a) &&
        [...a.slice(1)].every((c) => spec.has(`-${c}`) && spec.get(`-${c}`) === null)
      )
        for (const c of a.slice(1)) seen.add(`-${c}`);
      else return undefined; // not listed: unknown
    }
  }
  if (
    (entry.require ?? []).some((r) => !seen.has(r)) ||
    operands.length > (entry.max ?? MAX_OPERANDS)
  )
    return undefined;
  const ops = operandPaths(
    entry,
    operands,
    [...seen].some((f) => NO_PATTERN.has(f)),
  );
  return ops && [...paths, ...ops];
}

/** Judge the operands by the entry's rule; returns those that are paths, or undefined when the rule fails. */
function operandPaths(entry: Entry, ops: string[], noPattern: boolean): string[] | undefined {
  switch (entry.operands ?? "none") {
    case "none":
      return ops.length === 0 ? [] : undefined;
    case "path":
      return ops;
    case "pattern":
      return noPattern ? ops : ops.slice(1);
    case "sed":
      return /^\d+(,\d+)?p$/.test(ops[0] ?? "") ? ops.slice(1) : undefined;
    case "script":
      return ops.length === 1 && /^[a-z0-9:_-]+$/.test(ops[0]) ? [] : undefined;
    case "word":
      return ops.length <= 3 && ops.every((o) => KINDS.word.test(o)) ? [] : undefined;
    case "plain":
      return ops.length <= 1 && ops.every((o) => KINDS.plain.test(o)) ? [] : undefined;
    // A ref is returned as a path too: the caller resolves it inside the granted dirs and refuses one that names a file.
    case "ref":
      return ops.length <= 1 && ops.every(refOk) ? ops : undefined;
    case "delref":
      return ops.length === 1 && refOk(ops[0]) && !isFallbackDefault(ops[0]) ? [] : undefined;
    case "worktree":
      return ops.length === 2 && refOk(ops[1]) ? [ops[0]] : undefined;
    default:
      return []; // any
  }
}
