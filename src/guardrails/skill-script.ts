import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { allow, deny } from "./bash-command-checks";
import type { Segment } from "./bash-parser";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isSecretPath } from "./deny-dangerous";
import { isGitDirArg } from "./git-dir-guard";
import { isInside, realOrSame, resolveReal } from "./paths";

/** Interpreters a skill script may be started through (`bash <script>`), because some scripts are not exec-bit launched. */
const SCRIPT_SHELLS = new Set(["bash", "sh"]);

/** True when `p` (relative to `cwd`) is a regular file whose real path sits inside one of the run's skill dirs. */
function isSkillFile(p: string, cwd: string | undefined, skillDirs: readonly string[]): boolean {
  if (!p.includes("/") || (!isAbsolute(p) && !cwd)) return false; // a bare word is a PATH lookup, not the plugin's file
  try {
    const real = resolveReal(isAbsolute(p) ? p : join(cwd as string, p)); // realpath: `..` and symlinks resolved
    return skillDirs.some((d) => isInside(d, real)) && statSync(real).isFile();
  } catch {
    return false; // missing file, dangling symlink: the normal policy decides
  }
}

/**
 * Starting a script that ships with a skill loaded in THIS run: `<script> args` or `bash|sh <script> args` where the
 * script is a regular file inside the run's plugin dir(s) (`GuardrailContext.skillDirs`). Skills are the publisher's
 * (pinned, copied whole) and the owner chose to allow their scripts. Only the command word / the script operand is
 * judged here: the hard denies (sudo, eval, gh, secret files, writes to a git dir) still apply to every other segment,
 * and the script's arguments are trusted no further than any other command's. A shell with flags (`-c`) never matches.
 */
export function isSkillScript(
  seg: Segment,
  cwd: string | undefined,
  ctx: GuardrailContext,
  readOnly: boolean,
): boolean {
  const { words } = seg;
  const skillDirs = ctx.skillDirs;
  // Never piped, never after a cd into a read-only dir.
  if (readOnly || seg.piped || !skillDirs?.length || !words.length) return false;
  const [first, second] = words as [string, string | undefined];
  if (SCRIPT_SHELLS.has(basename(first))) return !!second && isSkillFile(second, cwd, skillDirs);
  return isSkillFile(first, cwd, skillDirs);
}

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

/** Flags whose value is a path the script WRITES under (start-server.sh `--project-dir`, an `--outfile`...). */
const PATH_FLAG = /^(project-dir|outfile|out|output|dir|path)$/;
/** Flags naming a bind/display host. */
const HOST_FLAG = /^(url-)?host$/;
/** Bind hosts a skill server may use: this machine only. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** Shell expansion in an argument: the guard cannot see what it becomes (leading `~` only: `HEAD~1` is plain). */
const EXPANDS = /[$`*?[{}]|^~/;

/** Index of the script word in `words` (after a `bash`/`sh`). */
const scriptIndex = (words: readonly string[]): number =>
  SCRIPT_SHELLS.has(basename(words[0] as string)) ? 1 : 0;

/** `inside(root, p)` for a real path, with `p` not yet created allowed (nearest ancestor resolved). */
export function realIn(roots: readonly string[], p: string): boolean {
  try {
    const real = resolveReal(p);
    return roots.some((r) => isInside(r, real));
  } catch {
    return false;
  }
}

/** A value that reads as a path: has a `/`, or starts with `.` or `~`. */
const PATH_LIKE = /\/|^[.~]/;

/**
 * Path rule for ONE path argument (a positional or a flag value). It must resolve (realpath; a not-yet-created file
 * through its nearest ancestor) inside the write paths, never inside a skill dir, never name or reach a git dir (a
 * planted `.git/config` or hook would run code in later app git calls: the raw text AND the real path are checked, so a
 * symlink to `.git` is covered) and never be a secret file. Only `readOk` (the PLAN_FILE) may be an existing
 * file inside the read paths instead. Returns a deny reason or undefined.
 */
function badPath(arg: string, cwd: string | undefined, ctx: GuardrailContext, readOk: boolean) {
  if (EXPANDS.test(arg)) return "shell expansion in a skill script argument is blocked";
  const abs = isAbsolute(arg) ? arg : cwd ? join(cwd, arg) : undefined;
  if (!abs) return "relative path argument without a known directory";
  const real = realOrSame(abs);
  if (isGitDirArg(arg) || isGitDirArg(real)) return "a skill script may not write to a git dir";
  if (isSecretPath(arg) || isSecretPath(real)) return "a skill script may not touch secret files";
  if (realIn(ctx.skillDirs ?? [], abs))
    return "a skill script may not be pointed at the skill directory";
  const writes = ctx.writePaths ?? [];
  const reads = [...writes, ...(ctx.readPaths ?? [])];
  const readable = readOk && existsSync(abs) && statSync(abs).isFile() && realIn(reads, abs);
  return realIn(writes, abs) || readable
    ? undefined
    : "a skill script argument leaves the allowed directories";
}

/**
 * Argument rule of a skill script (words before any `--`). Scripts write to path arguments (task-brief OUTFILE,
 * start-server `--project-dir`...), so: every non-flag argument is a path (`badPath`; only the first positional may be
 * the read-only PLAN_FILE); a flag's value (`--x=v`, glued `-ov`, the next word of a path flag such as
 * `--project-dir`) gets the same rule when it reads as a path; `--host`/`--url-host` (any case, one or two dashes)
 * must be loopback. Returns a deny reason, or undefined when the arguments pass.
 */
function badArg(args: readonly string[], cwd: string | undefined, ctx: GuardrailContext) {
  let first = true;
  for (let n = 0; n < args.length; n++) {
    const arg = args[n] as string;
    if (!arg.startsWith("-") || arg === "-") {
      const bad = badPath(arg, cwd, ctx, first);
      first = false;
      if (bad) return bad;
      continue;
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = (eq < 0 ? body : body.slice(0, eq)).toLowerCase();
    const next = args[n + 1];
    let value = eq >= 0 ? body.slice(eq + 1) : arg.startsWith("--") ? undefined : body.slice(1);
    if (HOST_FLAG.test(name) && !LOOPBACK.has((eq >= 0 ? value : next)?.toLowerCase() ?? ""))
      return "a skill server may bind to loopback only";
    if (PATH_FLAG.test(name) && eq < 0 && !value) {
      value = next; // `--project-dir X`: the next word is the value
      n++;
      if (value === undefined) return "path flag without a value";
    }
    if (value && (PATH_FLAG.test(name) || PATH_LIKE.test(value) || EXPANDS.test(value))) {
      const bad = badPath(value, cwd, ctx, false);
      if (bad) return bad;
    }
  }
  return undefined;
}

/**
 * Decision for a segment `isSkillScript` matched. The script is allowed only when its arguments pass `badArg`
 * (otherwise a HARD deny: under bypass an ask would run). A command it is GIVEN after `--` (a skill script's
 * `task-done PLAN N BASE -- <test command>`) runs inside it where the guard cannot see it: the words after EVERY `--`
 * are judged by `judge` like a line of their own, so the hard denies and the allowlist (`allowed`: command keys)
 * still decide them. The strictest decision wins.
 */
export function checkSkillScript(
  seg: Segment,
  allowed: ReadonlySet<string | null>,
  judge: (seg: Segment) => Decision,
  cwd: string | undefined,
  ctx: GuardrailContext,
): Decision {
  const words = seg.words;
  const from = scriptIndex(words) + 1;
  const firstDash = words.indexOf("--", from);
  const bad = badArg(words.slice(from, firstDash < 0 ? undefined : firstDash), cwd, ctx);
  if (bad) return deny(bad);
  let worst = allow("skill script of this run");
  for (let at = firstDash; at >= 0 && at < words.length; at = words.indexOf("--", at + 1)) {
    if (at === words.length - 1) break;
    const inner: Segment = { ...seg, words: words.slice(at + 1), redirect: false };
    let d = judge(inner);
    if (d.decision === "ask" && allowed.has(inner.words.join("\0")))
      d = allow("allowlisted command");
    if (RANK[d.decision] > RANK[worst.decision]) worst = d;
  }
  return worst;
}
