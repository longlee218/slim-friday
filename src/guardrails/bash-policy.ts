/**
 * Bash command policy: allow / ask / deny for a shell command line.
 *
 * Compound commands are split into segments (see bash-parser.ts) and each is judged on its
 * own; the strictest decision wins (deny > ask > allow). Anything that cannot be parsed asks.
 *
 * NOTE: parsing is BEST EFFORT and bypassable (variable expansion, scripts, aliases, ...).
 * Worktree isolation in phase 4 is the real boundary. Reasons are short and never echo
 * command text beyond host / package names, so secrets are not leaked to the agent.
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { parseCommand, type Segment } from "./bash-parser";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isSecretPath } from "./deny-dangerous";

/** Hosts curl/wget may reach without asking, unless the context overrides it. */
export const DEFAULT_ALLOWED_HOSTS = ["github.com", "api.github.com", "registry.npmjs.org"];

const RANK = { allow: 0, ask: 1, deny: 2 } as const;
const allow = (reason: string): Decision => ({ decision: "allow", reason });
const ask = (reason: string): Decision => ({ decision: "ask", reason });
const deny = (reason: string): Decision => ({ decision: "deny", reason });

/** Prefixes that run another command; stripped before judging the real command. */
const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Commands that print or copy file contents: must not touch secret files. */
const READERS = new Set([
  ...["cat", "less", "more", "head", "tail", "bat", "nl", "tac", "strings", "xxd", "od"],
  ...["grep", "rg", "awk", "sed", "cp", "mv", "base64", "source", ".", "tee", "sort", "cut"],
]);
const NETWORK = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "nc",
  "ncat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
]);
const PKG_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Strip `@` (curl -d @file) and `--opt=` prefixes, then test for a secret file name. */
function isSecretArg(arg: string): boolean {
  return isSecretPath(arg.replace(/^--?[\w-]+=/, "").replace(/^@/, ""));
}

/** Hostname of a URL-ish word, lowercased; null when unparseable. */
function hostOf(word: string): string | null {
  try {
    return new URL(word.includes("://") ? word : `http://${word}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** curl/wget: allow only when every URL/host-looking argument is in the allowlist. */
function checkNetwork(cmd: string, args: string[], hosts: string[]): Decision {
  if (cmd !== "curl" && cmd !== "wget") return ask(`network command ${cmd} needs approval`);
  // Output/upload/config flags can write or read anywhere: always ask.
  if (
    args.some(
      (a) =>
        /^-[a-zA-Z]*[oOTK]/.test(a) ||
        /^--(output|upload-file|config|remote-name|cookie-jar)/.test(a),
    )
  ) {
    return ask(`${cmd} with file output/upload flags`);
  }
  const targets = args.filter(
    (a) => a.includes("://") || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(a),
  );
  if (targets.length === 0) return ask(`${cmd} with no recognizable host`);
  for (const t of targets) {
    const host = hostOf(t);
    if (!host || !hosts.includes(host)) {
      return ask(`${cmd} to host not in allowlist: ${host ?? "unparseable"}`);
    }
  }
  return allow(`${cmd} to allowlisted host`);
}

/** rm: deny recursive + force in any flag form (-rf, -fr, -r -f, --recursive --force). */
function checkRm(args: string[]): Decision {
  const flags = args.filter((a) => a.startsWith("-"));
  const short = (re: RegExp) => flags.some((f) => !f.startsWith("--") && re.test(f));
  const recursive = short(/[rR]/) || flags.includes("--recursive");
  const force = short(/f/) || flags.includes("--force");
  return recursive && force ? deny("recursive force delete is blocked") : ask("rm needs approval");
}

/** chmod: deny world-writable mode on / or the home dir. */
function checkChmod(args: string[]): Decision {
  const open = args.some((a) => a === "777" || /^(a|ugo)?\+rwx$/.test(a));
  const roots = ["/", "/*", "~", "~/", "$HOME", "$HOME/", homedir()];
  return open && args.some((a) => roots.includes(a))
    ? deny("chmod 777 on / or home is blocked")
    : ask("chmod needs approval");
}

/** Refs that a push must never target. */
const PROTECTED = new Set(["main", "master"]);

/** git: allow read-only status/diff/log; deny force push and push to main/master. */
function checkGit(args: string[]): Decision {
  let i = 0;
  let configOverride = false;
  // Skip global options (and the value of those that take one) to find the subcommand.
  for (; i < args.length && args[i].startsWith("-"); i++) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i])) {
      if (args[i] === "-c") configOverride = true;
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
    const toProtected = rest
      .filter((a) => !a.startsWith("-"))
      .some((a) => PROTECTED.has((a.split(":").pop() ?? "").replace(/^refs\/heads\//, "")));
    return toProtected ? deny("push to main/master is blocked") : ask("git push needs approval");
  }
  if (rest.includes("--no-index")) return deny("git --no-index reads arbitrary files");
  if (sub === "status" || sub === "diff" || sub === "log") {
    const writesFile = rest.some((a) => a === "--output" || a.startsWith("--output="));
    return configOverride || writesFile ? ask(`git ${sub} with overrides`) : allow(`git ${sub}`);
  }
  return ask(`git ${sub ?? ""} needs approval`.replace("  ", " "));
}

/** Package managers: lockfile-only installs allow; adding packages asks with names. */
function checkPackageManager(cmd: string, args: string[]): Decision {
  const sub = args.find((a) => !a.startsWith("-"));
  const rest = args.filter((a) => !a.startsWith("-") && a !== sub);
  if (cmd === "npm" && sub === "ci") return allow("npm ci (lockfile install)");
  const adds = sub === "add" || (sub && ["install", "i"].includes(sub));
  if (!adds) return ask(`${cmd} ${sub ?? ""} needs approval`.replace("  ", " "));
  if (rest.length > 0) return ask(`${cmd} adds package: ${rest.join(", ").slice(0, 200)}`);
  if (cmd !== "npm" && args.includes("--frozen-lockfile")) {
    return allow(`${cmd} install --frozen-lockfile`);
  }
  return ask(`${cmd} install without lockfile guarantee`);
}

/** Judge one simple command. */
function checkSegment(seg: Segment, hosts: string[]): Decision {
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
  if (NETWORK.has(cmd)) return checkNetwork(cmd, args, hosts);
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
  const hosts = (ctx.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  const allowed = new Set((ctx.allowedCommands ?? []).map(commandKey));
  let worst: Decision | null = null;
  for (const seg of segments) {
    let d = checkSegment(seg, hosts);
    // Exact allowlisted commands only upgrade ask; hard denies still win.
    if (d.decision === "ask" && allowed.has(seg.words.join("\0"))) d = allow("allowlisted command");
    // A file redirect can write anywhere, so an otherwise-safe command must ask.
    if (d.decision === "allow" && seg.redirect) d = ask("output redirection needs approval");
    if (!worst || RANK[d.decision] > RANK[worst.decision]) worst = d;
    if (d.decision === "deny") break;
  }
  return worst ?? ask("empty command");
}
