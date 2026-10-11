/* Per-command checks of the Bash policy (network, rm, chmod, git, package managers). Each returns allow / ask / deny. */
import { homedir } from "node:os";
import type { Decision } from "./check-tool-call";
import { ownerAsk } from "./owner-only";

/** Hosts curl/wget may reach without asking. */
const ALLOWED_HOSTS = ["github.com", "api.github.com", "registry.npmjs.org"];

export const allow = (reason: string): Decision => ({ decision: "allow", reason });
export const ask = (reason: string): Decision => ({ decision: "ask", reason });
export const deny = (reason: string): Decision => ({ decision: "deny", reason });

/** Hostname of a URL-ish word, lowercased; null when unparseable. */
function hostOf(word: string): string | null {
  try {
    return new URL(word.includes("://") ? word : `http://${word}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** curl/wget: allow only when every URL/host-looking argument is in the allowlist. */
export function checkNetwork(cmd: string, args: string[]): Decision {
  if (cmd !== "curl" && cmd !== "wget") return ownerAsk(`network command ${cmd} needs approval`);
  // Output/upload/config flags can write or read anywhere: always ask.
  if (
    args.some(
      (a) =>
        /^-[a-zA-Z]*[oOTK]/.test(a) ||
        /^--(output|upload-file|config|remote-name|cookie-jar)/.test(a),
    )
  ) {
    return ownerAsk(`${cmd} with file output/upload flags`);
  }
  const targets = args.filter(
    (a) => a.includes("://") || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(a),
  );
  if (targets.length === 0) return ownerAsk(`${cmd} with no recognizable host`);
  for (const t of targets) {
    const host = hostOf(t);
    if (!host || !ALLOWED_HOSTS.includes(host)) {
      return ownerAsk(`${cmd} to host not in allowlist: ${host ?? "unparseable"}`);
    }
  }
  return allow(`${cmd} to allowlisted host`);
}

/** rm: deny recursive + force in any flag form (-rf, -fr, -r -f, --recursive --force). */
export function checkRm(args: string[]): Decision {
  const flags = args.filter((a) => a.startsWith("-"));
  const short = (re: RegExp) => flags.some((f) => !f.startsWith("--") && re.test(f));
  const recursive = short(/[rR]/) || flags.includes("--recursive");
  const force = short(/f/) || flags.includes("--force");
  return recursive && force ? deny("recursive force delete is blocked") : ask("rm needs approval");
}

/** chmod: deny world-writable mode on / or the home dir. */
export function checkChmod(args: string[]): Decision {
  const open = args.some((a) => a === "777" || /^(a|ugo)?\+rwx$/.test(a));
  const roots = ["/", "/*", "~", "~/", "$HOME", "$HOME/", homedir()];
  return open && args.some((a) => roots.includes(a))
    ? deny("chmod 777 on / or home is blocked")
    : ask("chmod needs approval");
}

/** Long options of `git status|diff|log` that only choose what to show (never run a program or write a file). */
const GIT_READ_LONG = new Set([
  ...[
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--summary",
    "--oneline",
  ],
  ...["--graph", "--decorate", "--no-decorate", "--all", "--branches", "--no-merges", "--merges"],
  ...["--first-parent", "--reverse", "--patch", "--no-patch", "--cached", "--staged", "--short"],
  ...["--branch", "--porcelain", "--untracked-files", "--ignored", "--no-color", "--color"],
  ...["--format", "--pretty", "--since", "--until", "--after", "--before", "--author", "--grep"],
  ...["--max-count", "--skip", "--date", "--abbrev", "--abbrev-commit", "--unified", "--follow"],
  ...["--diff-filter", "--word-diff", "--check", "--find-renames", "--no-renames", "--relative"],
]);

/** Refs that a push must never target. */
const PROTECTED = new Set(["main", "master"]);

/** git: allow read-only status/diff/log; deny force push and push to main/master. */
export function checkGit(args: string[]): Decision {
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
  // `git -C x`, `--git-dir`, `--work-tree`, `--exec-path`, `-p` ...: options before the subcommand move or run git elsewhere.
  const globalOption = i > 0;
  if (sub === "push") {
    const forced = rest.some(
      (a) => a.startsWith("--force") || /^-[^-]*f/.test(a) || a.startsWith("+"),
    );
    if (forced) return deny("force push is blocked");
    const toProtected = rest
      .filter((a) => !a.startsWith("-"))
      .some((a) => PROTECTED.has((a.split(":").pop() ?? "").replace(/^refs\/heads\//, "")));
    return toProtected
      ? deny("push to main/master is blocked")
      : deny("pushing is done by the app after the owner approves");
  }
  if (rest.includes("--no-index")) return deny("git --no-index reads arbitrary files");
  if (sub === "status" || sub === "diff" || sub === "log") {
    // Exact option names only: git accepts unique prefixes (`--out=`, `--ext-di`), so a denylist would miss them.
    const odd = rest.some(
      (a) =>
        (a.startsWith("--") && a !== "--" && !GIT_READ_LONG.has(a.split("=")[0] as string)) ||
        /^-O/.test(a),
    );
    return configOverride || odd || globalOption
      ? ask(`git ${sub} with overrides`)
      : allow(`git ${sub}`);
  }
  // Everything else (add, commit, checkout, ...): the git MCP tools are the way, not the shell.
  return deny(`use the git MCP tools instead of "git ${sub ?? ""}"`.replace("  ", " "));
}

/** Package managers: lockfile-only installs allow; adding packages asks with names. */
export function checkPackageManager(cmd: string, args: string[]): Decision {
  const sub = args.find((a) => !a.startsWith("-"));
  const rest = args.filter((a) => !a.startsWith("-") && a !== sub);
  if (cmd === "npm" && sub === "ci") return ask("npm ci runs lifecycle scripts");
  const adds = sub === "add" || (sub && ["install", "i"].includes(sub));
  if (!adds) return ask(`${cmd} ${sub ?? ""} needs approval`.replace("  ", " "));
  if (rest.length > 0) return ask(`${cmd} adds package: ${rest.join(", ").slice(0, 200)}`);
  if (cmd !== "npm" && args.includes("--frozen-lockfile")) {
    return allow(`${cmd} install --frozen-lockfile`);
  }
  return ask(`${cmd} install without lockfile guarantee`);
}
