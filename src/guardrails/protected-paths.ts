/**
 * Protected-dir rules (AGENT_HOME, `ctx.denyPaths`) that need more than "is this path inside": a run whose location
 * is an ANCESTOR of a denied dir (a `$HOME` location) can reach it by a wide search root, a recursive command, a glob,
 * a `cd`, `~user` or a git repo above it. Pure functions, best effort like the rest of the Bash guard.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { GuardrailContext } from "./check-tool-call";
import { isDeniedPath, isInside, realOrSame, resolveReal } from "./paths";

type Ctx = Pick<GuardrailContext, "denyPaths" | "allowInside" | "cwd">;

/** Base dir of the relative words of a Bash segment. `unknown` = a non-static `cd` came before it. */
export interface Base {
  dir: string | undefined;
  unknown: boolean;
}

/** Words the guard cannot resolve itself: variable, command substitution, home or brace expansion. */
const EXPANSION = /[$`~{}]/;
const GLOB = /[*?[]/;
/** Denial reason of a search root or recursive command that would cover a protected dir. */
export const COVERS_PROTECTED_REASON =
  "narrow the search path; it would cover a protected dir (the agent home)";

/** Expand a leading `~` / `$HOME` / `${HOME}` (the only expansions the guard resolves). */
export const expandHome = (w: string): string =>
  w.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, process.env.HOME || homedir());

/** Denied roots that are NOT wholly granted back by `allowInside`. */
const liveRoots = (ctx: Ctx): string[] =>
  (ctx.denyPaths ?? []).filter((d) => !(ctx.allowInside ?? []).some((a) => isInside(a, d)));

/** True when the real path of `dir` is an ancestor-or-equal of a denied root (a search from it would cover it). */
function containsDenied(dir: string, ctx: Ctx): boolean {
  const real = realOrSame(dir);
  return liveRoots(ctx).some((d) => isInside(real, d));
}

/** Glob/Grep: the search root (`path` or the cwd) must not contain a denied root, whatever the pattern. */
export function searchRootDenied(path: unknown, ctx: Ctx): boolean {
  if (!ctx.denyPaths?.length) return false;
  const root = typeof path === "string" && path ? path : ctx.cwd;
  const abs = root && (isAbsolute(root) ? root : ctx.cwd ? resolve(ctx.cwd, root) : undefined);
  return abs ? containsDenied(abs, ctx) : false;
}

/** Match one glob segment against a literal one. */
const segMatch = (pat: string, lit: string): boolean =>
  pat === lit || (GLOB.test(pat) && new Bun.Glob(pat).match(lit));

/** True when the absolute glob `pattern` can match a denied root, or (bulk) an ancestor of it, or anything under it. */
function globHits(pattern: string, ctx: Ctx, bulk: boolean): boolean {
  const segs = pattern.split("/").filter(Boolean);
  const stem = `/${segs
    .slice(
      0,
      segs.findIndex((s) => GLOB.test(s)),
    )
    .join("/")}`;
  // A pattern whose literal stem lies inside a granted dir cannot reach the denied root.
  if ((ctx.allowInside ?? []).some((a) => isInside(a, realOrSame(stem)))) return false;
  return liveRoots(ctx).some((d) => {
    const ds = d.split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] === "**" || i >= ds.length) return true; // deeper than the root, or `**`: inside it
      if (!segMatch(segs[i], ds[i])) return false;
    }
    return bulk; // the pattern names an ancestor of the root
  });
}

/** A relative word after a non-static `cd`: true when it could reach a denied root from wherever that cd went. */
function unknownBaseReach(w: string, ctx: Ctx): boolean {
  const segs = w.split("/").filter(Boolean);
  if (segs.includes("..")) return true;
  if (segs.length === 0) return false;
  return liveRoots(ctx).some((d) => {
    const ds = d.split("/").filter(Boolean);
    return ds.some((_, i) => segs.every((s, k) => k >= ds.length - i || segMatch(s, ds[i + k])));
  });
}

/** True when the real path of absolute `abs` is inside a denied root and outside the granted dirs. */
function insideDenied(abs: string, ctx: Ctx): boolean {
  try {
    return isDeniedPath(resolveReal(abs), ctx.denyPaths ?? [], ctx.allowInside);
  } catch {
    return false;
  }
}

/** One word of a Bash line: true when it names (or, for a bulk command, covers) a denied root. */
function wordDenied(word: string, ctx: Ctx, base: Base, bulk: boolean): boolean {
  const w0 = word.replace(/^--?[\w-]+=/, "").replace(/^@/, "");
  if (/^~[^/]/.test(w0)) return true; // ~user / ~+ / ~-: cannot be resolved safely
  const w = expandHome(w0);
  if (w === "" || EXPANSION.test(w)) return false;
  let abs = w;
  if (!isAbsolute(w)) {
    if (base.unknown) return !w.startsWith("-") && unknownBaseReach(w, ctx);
    if (!base.dir) return false;
    abs = resolve(base.dir, w);
  }
  if (GLOB.test(abs)) return globHits(abs, ctx, bulk);
  return insideDenied(abs, ctx) || (bulk && containsDenied(abs, ctx));
}

const hasFlag = (args: string[], short: RegExp, long: string[] = []): boolean =>
  args.some((a) => (a.startsWith("--") ? long.includes(a) : short.test(a)));

/** Recursive or bulk commands: a path word above the protected dir would walk into it. */
function isBulk(cmd: string, args: string[]): boolean {
  if (["rg", "find", "du", "tar", "rsync", "tree"].includes(cmd)) return true;
  if (cmd === "grep")
    return hasFlag(args, /^-[^-]*[rR]/, ["--recursive", "--dereference-recursive"]);
  if (cmd === "zip" || cmd === "scp") return hasFlag(args, /^-[^-]*r/, ["--recurse-paths"]);
  if (cmd === "cp") return hasFlag(args, /^-[^-]*[rRa]/, ["--recursive", "--archive"]);
  if (cmd === "ls") return hasFlag(args, /^-[^-]*R/, ["--recursive"]);
  if (["chmod", "chown", "chgrp"].includes(cmd)) return hasFlag(args, /^-[^-]*R/, ["--recursive"]);
  return false;
}

/** Commands that search the cwd when given no path. */
const IMPLICIT_CWD = new Set(["grep", "rg", "find", "du", "ls", "tree"]);

/**
 * True when a simple command (wrappers already stripped) touches a protected dir: a word inside it, a bulk command
 * on a word above it, a glob reaching it, `~user`, or a bulk command with no path run from a dir above it.
 */
export function segmentTouchesProtected(words: string[], ctx: Ctx, base: Base): boolean {
  if (!ctx.denyPaths?.length || words.length === 0) return false;
  const cmd = basename(words[0]);
  const args = words.slice(1);
  const bulk = isBulk(cmd, args);
  if (words.some((w) => wordDenied(w, ctx, base, bulk))) return true;
  if (!bulk) return false;
  if (base.unknown) return words.includes(".") || IMPLICIT_CWD.has(cmd);
  if (!base.dir || !containsDenied(base.dir, ctx)) return false;
  // No path argument (a bare `grep -r foo`, `find -name x`): it searches the cwd.
  const explicit = args.some(
    (a) => !a.startsWith("-") && (a.includes("/") || existsSync(resolve(base.dir as string, a))),
  );
  return IMPLICIT_CWD.has(cmd) && !explicit;
}

/** The base after `cd` / `pushd` / `popd` in `words`; undefined when the command is none of them. */
function afterCd(words: string[], base: Base): Base | undefined {
  const cmd = basename(words[0] ?? "");
  if (cmd === "popd") return { dir: undefined, unknown: true };
  if (cmd !== "cd" && cmd !== "pushd") return undefined;
  const target = words.slice(1).find((a) => a !== "--" && !/^-[LPe@]+$/.test(a));
  if (target === undefined) return { dir: process.env.HOME || homedir(), unknown: false };
  const t = expandHome(target);
  if (t === "-" || EXPANSION.test(t) || GLOB.test(t)) return { dir: undefined, unknown: true };
  if (isAbsolute(t)) return { dir: t, unknown: false };
  return base.dir && !base.unknown
    ? { dir: resolve(base.dir, t), unknown: false }
    : { dir: undefined, unknown: true };
}

/**
 * git with a repo or work tree above a protected dir could add it to the index or read it: deny `init` / `add` from such a dir and
 * `-C` / `--git-dir` / `--work-tree` pointing at one. A non-static value counts when the cwd itself is above it.
 */
export function gitReachesProtected(args: string[], ctx: Ctx, base: Base): boolean {
  if (!ctx.denyPaths?.length) return false;
  const above = (b: Base): boolean =>
    b.unknown || !b.dir ? !!ctx.cwd && containsDenied(ctx.cwd, ctx) : containsDenied(b.dir, ctx);
  let cur = base;
  let i = 0;
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    const [flag, inline] = a.split(/=(.*)/s);
    if (["-C", "--git-dir", "--work-tree"].includes(flag)) {
      const v = inline ?? args[++i];
      if (v === undefined) break;
      const next = afterCd(["cd", v], flag === "-C" ? cur : base) ?? cur;
      if (flag === "-C") cur = next;
      if (above(next)) return true;
      // The work tree of a `--git-dir` is its parent when none is given.
      if (flag === "--git-dir" && next.dir && above({ dir: dirname(next.dir), unknown: false }))
        return true;
    } else if (a === "-c" || a === "--namespace") i++;
  }
  const sub = args[i];
  if (sub !== "init" && sub !== "add") return false;
  if (above(cur)) return true;
  // `git init <dir>`: the new repo's dir.
  return (
    sub === "init" &&
    args.slice(i + 1).some((a) => !a.startsWith("-") && above(afterCd(["cd", a], cur) ?? cur))
  );
}

/**
 * Tracks the base dir of relative words across the segments of one line: a `cd` moves it for the segments that
 * follow, per nesting depth (a subshell's `cd` ends with the subshell).
 */
export function baseTracker(cwd: string | undefined) {
  const stack: { depth: number; base: Base }[] = [];
  return {
    at(depth: number): Base {
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      return stack[stack.length - 1]?.base ?? { dir: cwd, unknown: false };
    },
    after(seg: { words: string[]; depth: number }): void {
      const moved = afterCd(seg.words, this.at(seg.depth));
      if (!moved) return;
      const top = stack[stack.length - 1];
      if (top?.depth === seg.depth) top.base = moved;
      else stack.push({ depth: seg.depth, base: moved });
    },
  };
}
