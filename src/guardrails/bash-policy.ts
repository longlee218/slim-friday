/**
 * Bash command policy: allow / ask / deny for a shell command line.
 *
 * Compound commands are split into segments (see bash-parser.ts) and each is judged on its
 * own; the strictest decision wins (deny > ask > allow). Anything that cannot be parsed asks.
 *
 * NOTE: parsing is BEST EFFORT and bypassable (variable expansion, scripts, aliases, ...).
 * The git worktree is the real boundary. Reasons are short and never echo
 * command text beyond host / package names, so secrets are not leaked to the agent.
 */
import { basename } from "node:path";
import { type CdState, checkCd } from "./bash-cd";
import {
  allow,
  ask,
  checkChmod,
  checkGit,
  checkNetwork,
  checkPackageManager,
  checkRm,
  deny,
} from "./bash-command-checks";
import { parseCommand, type Segment } from "./bash-parser";
import { isPureGitRead, isReadCommand } from "./bash-read-commands";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isSecretPath } from "./deny-dangerous";
import { writesGitDir } from "./git-dir-guard";

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

/** Prefixes that run another command; stripped before judging the real command. */
const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Commands that print or copy file contents: must not touch secret files. */
const READERS = new Set([
  ...["cat", "less", "more", "head", "tail", "bat", "nl", "tac", "strings", "xxd", "od"],
  ...["grep", "rg", "awk", "sed", "cp", "mv", "base64", "source", ".", "tee", "sort", "cut"],
]);
const NETWORK = new Set([
  ...["curl", "wget", "http", "https", "nc", "ncat", "telnet"],
  ...["ssh", "scp", "sftp", "rsync", "ftp"],
]);
const PKG_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Strip `@` (curl -d @file) and `--opt=` prefixes, then test for a secret file name. */
function isSecretArg(arg: string): boolean {
  return isSecretPath(arg.replace(/^--?[\w-]+=/, "").replace(/^@/, ""));
}

/** Judge one simple command. */
function checkSegment(seg: Segment): Decision {
  const words = [...seg.words];
  // Drop env assignments and wrapper commands (`FOO=1 env nice cmd`).
  while (words.length > 0) {
    if (/^(PATH|LD_\w+|DYLD_\w+|GIT_\w+|NODE_OPTIONS|BASH_ENV)=/.test(words[0])) {
      return ask("environment override needs approval");
    }
    if (/^[A-Za-z_]\w*=/.test(words[0])) words.shift();
    else if (WRAPPERS.has(basename(words[0]))) {
      words.shift();
      while (words[0]?.startsWith("-")) words.shift();
    } else break;
  }
  if (words.length === 0) return ask("no command to evaluate");
  const cmd = basename(words[0]);
  const args = words.slice(1);

  // The clone's git dir (hooks, config) may be read, never written: it would run code in later app git calls.
  if (writesGitDir(cmd, args, seg.redirect))
    return deny("writing to the .git directory is blocked");
  if (["sudo", "su", "doas"].includes(cmd)) return deny("privilege escalation is blocked");
  if (cmd === "eval") return deny("eval is blocked");
  if (SHELLS.has(cmd)) {
    const inline = args.some((a) => /^-[a-zA-Z]*c/.test(a));
    const hasScript = args.some((a) => !a.startsWith("-"));
    if (seg.piped) return deny("piping into a shell is blocked");
    if (inline || !hasScript) return deny("shell wrapper (-c / stdin) is blocked");
    return ask("running a shell script needs approval");
  }
  if ((READERS.has(cmd) || NETWORK.has(cmd) || cmd === "git") && args.some(isSecretArg)) {
    return deny("access to secret files is blocked");
  }
  if (cmd === "rm") return checkRm(args);
  if (cmd === "chmod") return checkChmod(args);
  if (cmd === "git") return checkGit(args);
  if (NETWORK.has(cmd)) return checkNetwork(cmd, args);
  if (PKG_MANAGERS.has(cmd)) return checkPackageManager(cmd, args);
  return ask(`${cmd} needs approval`);
}

/** Canonical key of a single simple command, used to match allowedCommands. */
function commandKey(command: string): string | null {
  try {
    const segs = parseCommand(command);
    return segs.length === 1 ? segs[0].words.join("\0") : null;
  } catch {
    return null;
  }
}

/** Decide a Bash command line. Strictest segment wins; unparseable input asks. */
export function checkBash(command: string, ctx: GuardrailContext): Decision {
  let segments: Segment[];
  try {
    segments = parseCommand(command);
  } catch {
    return ask("command could not be parsed");
  }
  if (segments.length === 0) return ask("empty command");
  const allowed = new Set((ctx.allowedCommands ?? []).map(commandKey));
  const roots = [...(ctx.writePaths ?? []), ...(ctx.readPaths ?? [])];
  // `cwd` follows the line's `cd`s. After a cd into a dir that is only READABLE nothing may write or install there:
  // later segments must be pure git reads or read commands (an allowed `bun install` there would write node_modules).
  let cwd = ctx.cwd;
  let readOnly = false;
  let worst: Decision | null = null;
  let prevCd = false; // the previous segment was a tracked cd (it ran, or the line stopped there)
  for (const [n, seg] of segments.entries()) {
    // A cd moves the guard's cwd only when it surely runs in the main shell: top level, not piped, joined by `&&`
    // or `;`, and not skipped by an earlier `&&` / `||` / background command. Anything else asks.
    const seq = ["&&", ";", "\n", ""].includes(seg.next);
    const reached: boolean = n === 0 || prevCd || [";", "\n"].includes(segments[n - 1]?.next ?? "");
    const cd: CdState | undefined =
      seg.depth === 0 && !seg.piped && seq && reached
        ? checkCd(seg.words, cwd, ctx.writePaths ?? [], ctx.readPaths ?? [])
        : undefined;
    prevCd = !!cd;
    let d: Decision;
    if (cd) {
      d = allow("cd inside allowed directory");
      cwd = cd.cwd;
      readOnly ||= cd.readOnly;
    } else if (isReadCommand(seg.words, cwd, roots)) {
      d = allow("read-only command");
    } else {
      d = checkSegment(seg);
      if (d.decision === "allow" && (readOnly || seg.words[0] === "git")) {
        if (!isPureGitRead(seg.words, cwd, roots))
          d = ask("only git reads inside the allowed directories run here");
      } else if (readOnly) {
        // nothing else runs in a read-only directory
      } else if (d.decision === "ask" && allowed.has(seg.words.join("\0"))) {
        // Exact allowlisted commands only upgrade ask; hard denies still win.
        d = allow("allowlisted command");
      }
    }
    // A file redirect can write anywhere, so an otherwise-safe command must ask.
    if (d.decision === "allow" && seg.redirect) d = ask("output redirection needs approval");
    if (!worst || RANK[d.decision] > RANK[worst.decision]) worst = d;
    if (d.decision === "deny") break;
  }
  // An expansion anywhere (`$VAR`, `${..}`, `$(..)`, backtick, `~`, `{a,b}`, `<(..)`) can read what the guard never saw
  // (env secrets leak through error text): the line never runs without the owner. A deny stays a deny.
  const expands =
    /[<>]\(/.test(command) ||
    segments.some((s) => s.words.some((w) => /[$`{}]/.test(w) || w.startsWith("~")));
  if (expands && worst?.decision === "allow") return ask("shell expansion needs approval");
  return worst ?? ask("empty command");
}
