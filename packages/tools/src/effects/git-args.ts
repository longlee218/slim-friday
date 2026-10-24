import type { EffectsContext } from "./effects-context";
import { resolveReal } from "./workspace-paths";

/** A branch, remote or base name: starts with a letter or digit, so it can never be read as an option. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** True for a plain git name: no option (`-x`), refspec (`+a`, `a:b`), space or `..` traversal. */
export function isPlainName(s: string): boolean {
  return PLAIN_NAME.test(s) && !s.includes("..");
}

/** The real path of `workspace` when it equals one of the bot's workspaces (real paths compared), else undefined. */
export function grantedWorkspace(ctx: EffectsContext, workspace: string): string | undefined {
  const real = (p: string) => {
    try {
      return resolveReal(p);
    } catch {
      return undefined;
    }
  };
  const target = real(workspace);
  return target && ctx.workspaces.some((w) => real(w) === target) ? target : undefined;
}

/** Reply text for a workspace that is not granted. */
export const NOT_GRANTED = "Refused: not one of your workspaces.";

/** Reply text for a name that is not plain. */
export const badName = (field: string) =>
  `Refused: ${field} must be a plain name (letters, digits, . _ / -; no leading -, no ..).`;

/** Repo config keys that make git run a program (or pull in another config file): a bot can write the repo config. */
const COMMAND_KEYS = [
  /^core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$/,
  /^(filter|gpg|credential|include|includeif|protocol|pager|alias|sequence)\./,
  /^merge\..+\.driver$/,
  /^diff\..+\.(command|textconv)$/,
  /^remote\..+\.(uploadpack|receivepack|proxy)$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
];

/**
 * Run git in a granted workspace without letting the repo run code: the repo's local config is checked first (a key
 * that runs a program refuses the call) and hooks are switched off. Returns git's result, or the refusal text.
 */
export async function runGit(
  ctx: EffectsContext,
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string } | string> {
  const list = await ctx.run(["git", "config", "--local", "--includes", "--list"], cwd);
  if (list.code !== 0) return list.out.trim() || "git config failed";
  const bad = list.out
    .split("\n")
    .map((l) => l.slice(0, l.indexOf("=") >>> 0).toLowerCase())
    .find((k) => k && COMMAND_KEYS.some((r) => r.test(k)));
  if (bad) return `Refused: the repo config sets ${bad}, which can run a program.`;
  return ctx.run(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd);
}
