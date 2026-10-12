/**
 * Bash command policy: a DENY LIST. A command line is split into segments (bash-parser.ts) and every segment is
 * checked; the first deny wins, everything else runs without asking (bypass mode: the owner's agent works freely).
 *
 * Denied: privilege escalation, secret files as arguments, `rm -r` outside the work dirs, force push / push to
 * main/master, `push --mirror/--all`, `gh repo delete` / `gh api` DELETE / printing the gh token, a pipe into a
 * shell, and a git worktree created outside the workspace's worktrees dir. Everything else runs: `git` (commit, branch, push of a non-default branch), `gh`/`hub`, network, package managers,
 * scripts, `sh -c`, `$(..)`, `~`, redirects, cd.
 *
 * NOTE: parsing is BEST EFFORT and bypassable (variable expansion, `sh -c`, scripts, aliases ...). Reasons are
 * short and never echo command text, so secrets are not leaked to the agent.
 */
import { basename, isAbsolute, resolve } from "node:path";
import { parseCommand, type Segment } from "./bash-parser";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isSecretPath } from "./deny-dangerous";
import { ghDenial, RAW_GH_DENY } from "./gh-policy";
import { isInside, realOrSame } from "./paths";

const allow = (reason: string): Decision => ({ decision: "allow", reason });
const deny = (reason: string): Decision => ({ decision: "deny", reason });

/**
 * Prefixes that run another command; stripped before judging the real command. The value: their flags that take a
 * separate value (dropped with the flag, so `nice -n 5 sudo id` still reaches `sudo`).
 */
const WRAPPERS = new Map<string, Set<string>>([
  ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir"])],
  ["command", new Set()],
  ["nohup", new Set()],
  ["time", new Set()],
  ["exec", new Set(["-a"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["builtin", new Set()],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["setsid", new Set()],
  ["xargs", new Set(["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "-J"])],
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Interpreters that run a script read from a pipe, like a shell does. */
const INTERPRETER = /^(python[\d.]*|node|perl|ruby)$/;
/** Commands that print or copy file contents: must not touch secret files. */
const READERS = new Set([
  ...["cat", "less", "more", "head", "tail", "bat", "nl", "tac", "strings", "xxd", "od"],
  ...["grep", "rg", "awk", "sed", "cp", "mv", "base64", "source", ".", "tee", "sort", "cut"],
]);
const NETWORK = new Set([
  ...["curl", "wget", "http", "https", "nc", "ncat", "telnet"],
  ...["ssh", "scp", "sftp", "rsync", "ftp"],
]);
/** Refs that a push must never target. */
const PROTECTED = new Set(["main", "master"]);
/** Words the guard cannot resolve itself: variable, command substitution, home or brace expansion. */
const EXPANSION = /[$`~{}]/;

/** Strip `@` (curl -d @file) and `--opt=` prefixes, then test for a secret file name. */
function isSecretArg(arg: string): boolean {
  return isSecretPath(arg.replace(/^--?[\w-]+=/, "").replace(/^@/, ""));
}

/** Absolute form of `p` (relative ones against `base`); undefined when it is relative and `base` is unknown. */
const absolute = (p: string, base: string | undefined): string | undefined =>
  isAbsolute(p) ? p : base ? resolve(base, p) : undefined;

/** True when the real path `abs` lies inside one of `roots`. */
const insideAny = (abs: string, roots: string[]): boolean =>
  roots.some((r) => isInside(realOrSame(r), realOrSame(abs)));

/** `put worktrees under <dirs>` denial, shared by `git worktree add` and the EnterWorktree tool. */
const worktreeDenial = (ctx: GuardrailContext): Decision =>
  deny(
    ctx.worktreeDirs?.length
      ? `put worktrees under ${ctx.worktreeDirs.join(", ")} (a literal path, no expansion)`
      : "creating worktrees is not allowed here",
  );

/** The one worktree rule: `path` must be literal and inside `ctx.worktreeDirs` (`base` resolves a relative one). */
export function checkWorktreePath(
  path: string | undefined,
  base: string | undefined,
  ctx: GuardrailContext,
): Decision {
  if (!path || EXPANSION.test(path) || /[*?[]/.test(path)) return worktreeDenial(ctx);
  const abs = absolute(path, base);
  return abs && ctx.worktreeDirs && insideAny(abs, ctx.worktreeDirs)
    ? allow("worktree inside the worktrees dir")
    : worktreeDenial(ctx);
}

/** rm: with a recursive flag every target must resolve inside the write paths, /tmp or the worktrees dirs. */
function checkRm(args: string[], ctx: GuardrailContext, viaXargs: boolean): Decision {
  const flags = args.filter((a) => a.startsWith("-") && a !== "--");
  const recursive = flags.some((f) => (f.startsWith("--") ? f === "--recursive" : /[rR]/.test(f)));
  if (!recursive) return allow("rm");
  // `xargs rm -r`: the targets come from stdin, the guard cannot see them.
  if (viaXargs) return deny("recursive delete of unknown targets (xargs) is blocked");
  const roots = [...(ctx.writePaths ?? []), "/tmp", ...(ctx.worktreeDirs ?? [])];
  for (const t of args.filter((a) => a !== "--" && !a.startsWith("-"))) {
    // Home, `$VAR`, backticks, braces: the guard cannot prove the target is safe. A glob is judged by its stem
    // (`out/*` -> `out/`, `/*` -> `/`, a lone `*` -> the cwd).
    const stem = t.replace(/[*?[].*$/, "") || ".";
    const abs = EXPANSION.test(t) ? undefined : absolute(stem, ctx.cwd);
    if (!abs || !insideAny(abs, roots))
      return deny("recursive delete outside the work directories is blocked");
  }
  return allow("rm inside the work directories");
}

/** git: deny force push, push to main/master and a worktree outside the dir; every other git command (a push included) runs. */
function checkGit(args: string[], ctx: GuardrailContext): Decision {
  let i = 0;
  let base = ctx.cwd; // `git -C <dir>` moves the base of relative paths
  // Skip global options (and the value of those that take one) to find the subcommand.
  for (; i < args.length && args[i].startsWith("-"); i++) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i])) {
      if (args[i] === "-C" && args[i + 1]) base = absolute(args[i + 1], ctx.cwd);
      i++;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "push") {
    const forced = rest.some(
      (a) => a.startsWith("--force") || /^-[^-]*f/.test(a) || a.startsWith("+"),
    );
    if (forced) return deny("force push is blocked");
    if (rest.some((a) => a === "--mirror" || a === "--all"))
      return deny("push --mirror/--all is blocked");
    const toProtected = rest
      .filter((a) => !a.startsWith("-"))
      .some((a) => PROTECTED.has((a.split(":").pop() ?? "").replace(/^refs\/heads\//, "")));
    return toProtected ? deny("push to main/master is blocked") : allow("git push");
  }
  if (sub === "worktree" && rest[0] === "move") {
    // `move <worktree> <new-path>`: the destination is the second positional.
    return checkWorktreePath(rest.slice(1).filter((a) => !a.startsWith("-"))[1], base, ctx);
  }
  if (sub === "worktree" && rest[0] === "add") {
    // First positional after `add`; `-b/-B <branch>` and `--reason <text>` take a value.
    const tail = rest.slice(1);
    const at = tail.findIndex(
      (a, n) => !a.startsWith("-") && !["-b", "-B", "--reason"].includes(tail[n - 1] ?? ""),
    );
    return checkWorktreePath(tail[at], base, ctx);
  }
  return allow("git");
}

/** Judge one simple command. */
function checkSegment(seg: Segment, ctx: GuardrailContext): Decision {
  const words = [...seg.words];
  // Drop env assignments and wrapper commands (`FOO=1 env nice -n 5 cmd`), with the flag values of the wrapper.
  let viaXargs = false;
  while (words.length > 0) {
    const wrapper = WRAPPERS.get(basename(words[0]));
    if (/^[A-Za-z_]\w*=/.test(words[0])) words.shift();
    else if (wrapper) {
      viaXargs ||= basename(words[0]) === "xargs";
      const isTimeout = basename(words[0]) === "timeout";
      words.shift();
      while (words[0]?.startsWith("-")) {
        const flag = words.shift() as string;
        if (wrapper.has(flag)) words.shift();
      }
      if (isTimeout) words.shift(); // the duration
    } else break;
  }
  if (words.length === 0) return allow("no command");
  const cmd = basename(words[0]);
  const args = words.slice(1);

  if (["sudo", "su", "doas"].includes(cmd)) return deny("privilege escalation is blocked");
  if ((SHELLS.has(cmd) || INTERPRETER.test(cmd)) && seg.piped)
    return deny("piping into a shell or interpreter is blocked");
  if ((READERS.has(cmd) || NETWORK.has(cmd) || cmd === "git") && args.some(isSecretArg))
    return deny("access to secret files is blocked");
  const gh = cmd === "gh" ? ghDenial(args) : undefined;
  if (gh) return deny(gh);
  if (cmd === "rm") return checkRm(args, ctx, viaXargs);
  if (cmd === "git") return checkGit(args, ctx);
  return allow("no deny rule matched");
}

/** Raw-text patterns for a line that cannot be tokenized: the clearest dangers only (best effort, coarse). */
const RAW_DENY: RegExp[] = [
  /(^|[\s;&|(`])(sudo|su|doas)(\s|$)/,
  /(^|[\s;&|(`])rm\s+(-\S*[rR]|--recursive)/,
  // A forced push (`--force*`, `-f`, `+ref`) or a push naming main/master (`main`, `HEAD:main`, `refs/heads/main`):
  // only these are denied here, any other push runs.
  /\bgit\b[^\n]*\bpush\b[^\n]*(\s--force|\s-[a-zA-Z]*f|\s\+\S)/,
  /\bgit\b[^\n]*\bpush\b[^\n]*(\s|:|refs\/heads\/)(main|master)(\s|$|["';&|)])/,
  /\bgit\b[^\n]*\bpush\b[^\n]*\s--(mirror|all)\b/,
  ...RAW_GH_DENY,
  /\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|perl|ruby)\b/,
];

/** True when the raw text of an unparseable line hits a clear danger or names a secret file. */
const rawDanger = (command: string): boolean =>
  RAW_DENY.some((re) => re.test(command)) ||
  command.split(/[\s'"`;&|()<>=]+/).some((w) => w !== "" && isSecretPath(w));

/**
 * Decide a Bash command line: the first segment that hits a deny rule decides, else allow. A line that still cannot
 * be tokenized (unbalanced quote, paren or backtick) gets a coarse raw-text check instead: a match is denied with a
 * "rewrite" reason, anything else runs (the parser is best effort and the owner chose a deny list).
 */
export function checkBash(command: string, ctx: GuardrailContext): Decision {
  let segments: Segment[];
  try {
    segments = parseCommand(command);
  } catch {
    return rawDanger(command)
      ? deny("command could not be parsed and looks dangerous: rewrite it as simple commands")
      : allow("command not parsed, not checked");
  }
  for (const seg of segments) {
    const d = checkSegment(seg, ctx);
    if (d.decision === "deny") return d;
  }
  return allow("no deny rule matched");
}
