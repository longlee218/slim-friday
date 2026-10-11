import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { checkGit } from "./bash-command-checks";
import { isSecretPath } from "./deny-dangerous";
import { isGitDirArg } from "./git-dir-guard";
import { isInside, resolveReal } from "./paths";

/* Read-only shell commands that need no approval (ls, cat, head, wc, ...), under the rule of the Read tool: they may
   not read anything Read could not. Two layers, both fail closed:
   - FLAGS: every flag must be on the command's ALLOWLIST (short flags, flags that take a value, a few exact long
     flags; no `--opt=value`, no abbreviations). So options that read or write files (`--file=`, `-f path`,
     `--files0-from`, `--out=`, `-i`, `-o`, `--pre`), follow symlinks (`-L`) or recurse into contents (`grep -r`,
     `rg` on a directory, `rg -u`) simply ask. The same list works on BSD (macOS) and GNU (Linux) userlands.
   - PATHS: every path operand (after realpath) is inside the allowed roots, not a secret file, not under the git
     dir; arguments the parser does not expand (`$VAR`, `~`, `{a,b}`, substitutions) ask; a glob is expanded here and
     every match must pass too. Use the Grep tool for recursive content search. */

/** What a command may be given: `short` letters (bundles like `-la` are fine), `value` letters whose value follows or is attached, exact `long` flags, and whether `-5` (digits) is a flag. */
interface FlagSpec {
  short: string;
  value?: string;
  long?: string[];
  digits?: boolean;
}

const GREP_LONG = [
  ...["--ignore-case", "--line-number", "--count", "--invert-match", "--word-regexp"],
  ...["--files-with-matches", "--no-filename", "--with-filename", "--fixed-strings"],
  ...["--extended-regexp", "--only-matching"],
];

const SPECS: Record<string, FlagSpec> = {
  ls: { short: "1AaCdFfghiklmnopqRrSsTtux", long: ["--all", "--almost-all", "--human-readable"] },
  cat: { short: "AbeEnstuvT", long: ["--number"] },
  head: { short: "qv", value: "nc", digits: true },
  tail: { short: "qv", value: "nc", digits: true }, // no -f / -F: they never end
  wc: { short: "clmwL", long: ["--lines", "--words", "--bytes", "--chars"] },
  nl: { short: "" },
  file: { short: "bhiNnps" },
  stat: { short: "xFnqrst" },
  du: { short: "ahkmsxc", value: "d", long: ["--human-readable", "--summarize"] },
  tree: { short: "aAdfFhpsugDiqtrxnCNQ", value: "LPI" }, // no -l (follows links), no -o
  grep: { short: "iHhnclLvwxEFosqaIUb", value: "ABCme", digits: true, long: GREP_LONG }, // no -r/-R/-d/-f
  rg: { short: "ijnlcFwsSoNHIq", value: "ABCmeg", long: GREP_LONG }, // no -u/-L/-z/--hidden/--file
  sort: { short: "bdfgMnrRuVchsz", value: "kt", long: ["--reverse", "--numeric-sort", "--unique"] }, // no -o/-T/-S
  cut: { short: "sn", value: "dfcb" },
  uniq: { short: "cdiu", value: "fsw" },
};

/** `find` primaries that are safe, and whether each takes a value (no -newer / -exec / -L / -follow / -fprint*). */
const FIND: Record<string, boolean> = Object.fromEntries([
  ...["-name", "-iname", "-path", "-ipath", "-wholename", "-type"].map((p) => [p, true]),
  ...["-maxdepth", "-mindepth", "-size", "-mtime", "-mmin"].map((p) => [p, true]),
  ...["-empty", "-print", "-print0", "-prune", "-not", "-o", "-a", "-depth"].map((p) => [p, false]),
]);

/** The non-flag operands of `args` when every flag is allowed; undefined when any flag is not. */
function operandsOf(spec: FlagSpec, args: string[]): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-" || !a.startsWith("-")) out.push(a);
    else if (a.startsWith("--")) {
      if (!spec.long?.includes(a)) return undefined;
    } else if (spec.digits && /^-\d+$/.test(a)) continue;
    else {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k] as string;
        if (spec.value?.includes(ch)) {
          if (k === a.length - 1) i++; // the value is the next argument
          break; // else the rest of the bundle is the value
        }
        if (!spec.short.includes(ch)) return undefined;
      }
    }
  }
  return out;
}

/** A path inside the roots that is neither a secret file nor in a git dir (symlinks resolved). */
function readablePath(real: string, roots: string[]): boolean {
  return (
    roots.some((r) => isInside(r, real)) &&
    !isSecretPath(real) &&
    !real.split(/[\\/]/).includes(".git")
  );
}

/** Most glob matches checked per argument (a bigger expansion asks). */
const MAX_MATCHES = 500;

/** One path argument: no expansion the parser skipped, inside the roots, every glob match readable too. */
function pathOk(arg: string, cwd: string | undefined, roots: string[]): boolean {
  if (/[$`~{}]/.test(arg) || isGitDirArg(arg) || !(isAbsolute(arg) || cwd)) return false;
  const abs = isAbsolute(arg) ? arg : join(cwd as string, arg);
  try {
    if (!/[*?[]/.test(arg)) return readablePath(resolveReal(abs), roots);
    // Glob: the dir part must be readable, then each match (the shell skips dotfiles; so does the scan).
    const segs = abs.split("/");
    const at = segs.findIndex((s) => /[*?[]/.test(s));
    const dir = resolveReal(segs.slice(0, at).join("/") || "/");
    const pattern = segs.slice(at).join("/");
    if (!readablePath(dir, roots) || pattern.split("/").includes("..")) return false;
    let n = 0;
    const dot = /(^|\/)\./.test(pattern); // like the shell: dotfiles only for a pattern that names them
    for (const m of new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: false, dot })) {
      if (++n > MAX_MATCHES || !readablePath(resolveReal(join(dir, m)), roots)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** `sed -n <N | N,M | $>p <files>`: exactly that (any other flag, script or trailing option asks). */
function sedOperands(args: string[]): string[] | undefined {
  const files = args.slice(2);
  const ok = args[0] === "-n" && /^(\d+|\$)(,(\d+|\$))?p$/.test(args[1] ?? "");
  return ok && files.every((f) => f === "-" || !f.startsWith("-")) ? files : undefined;
}

/** `find <paths> <safe primaries>`: the path operands, or undefined when a primary is not on the list. */
function findOperands(args: string[]): string[] | undefined {
  const paths: string[] = [];
  let expression = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("-") && a !== "!") {
      if (expression) return undefined; // a stray word after the expression: not understood
      paths.push(a);
    } else if (a in FIND) {
      expression = true;
      if (FIND[a]) i++; // its value
    } else if (a !== "!") return undefined;
  }
  return paths;
}

/** `rg PATTERN FILE...`: every path operand must be a plain file (a directory, or none, would make it search content). */
function rgFilesOnly(operands: string[], args: string[], cwd: string | undefined): boolean {
  const withE = args.some((a) => /^-[A-Za-z]*e/.test(a));
  const files = operands.slice(withE ? 0 : 1);
  if (!files.length || !cwd) return false;
  return files.every((f) => {
    try {
      return !/[*?[]/.test(f) && statSync(resolveReal(isAbsolute(f) ? f : join(cwd, f))).isFile();
    } catch {
      return false;
    }
  });
}

/** True when `words` is one of the read-only commands, run safely: see the header. `cwd` = the dir it runs in. */
export function isReadCommand(words: string[], cwd: string | undefined, roots: string[]): boolean {
  const [cmd = "", ...args] = words;
  const spec = SPECS[cmd];
  let operands: string[] | undefined;
  if (cmd === "sed") operands = sedOperands(args);
  else if (cmd === "find") operands = findOperands(args);
  else if (spec) operands = operandsOf(spec, args);
  if (!operands) return false;
  if (cmd === "uniq" && operands.length > 1) return false; // the 2nd operand is an OUTPUT file
  if (cmd === "rg" && !rgFilesOnly(operands, args, cwd)) return false;
  // No operand (`ls`, `head -5` after a pipe) works on the cwd / stdin: only safe when the guard knows the cwd.
  if (!cwd && operands.length === 0) return false;
  return operands.every((a) => a === "-" || pathOk(a, cwd, roots));
}

/**
 * `git status|diff|log` with only allowlisted options (see `checkGit`: no global option, no external diff driver, no
 * output file) whose path operands (after `--` or bare) are inside the roots like those of the read commands.
 */
export function isPureGitRead(words: string[], cwd: string | undefined, roots: string[]): boolean {
  if (words[0] !== "git" || checkGit(words.slice(1)).decision !== "allow") return false;
  // After `--` every word is a path; before it a bare word is a revision unless it looks like a path (`/`, `..`, leading dot).
  const dashes = words.indexOf("--");
  return words.slice(2).every((a, k) => {
    if (a === "--" || (a.startsWith("-") && (dashes < 0 || k + 2 < dashes))) return true;
    const pathLike = dashes >= 0 && k + 2 > dashes ? true : /[\\/]|^\./.test(a) || a.includes("..");
    return !pathLike || pathOk(a, cwd, roots);
  });
}
