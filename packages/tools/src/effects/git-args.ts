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
