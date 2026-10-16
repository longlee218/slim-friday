import { isAbsolute } from "node:path";
import type { GuardrailContext } from "./check-tool-call";
import { isInside, realOrSame } from "./paths";
import type { RiskClass } from "./risk-types";
import { gitPaths, revWordsOk } from "./shell-git-extras";
import { cwdGranted, pathGranted, readRoots, writeRoots } from "./shell-paths";
import { shapeOf } from "./shell-shape";
import { checkArgs, matchCommand } from "./shell-table";

/* Worker shell policy: DEFAULT DENY BY SHAPE (shell-shape.ts), then an exact table (shell-table.ts, data in
   config/data/worker-bash-allowlist.yaml), then granted paths (shell-paths.ts). Every miss is unknown = R2, never a guess. Pure. */

/** Verdict on a command line: its class and, for a command an effect tool replaces, that tool. */
export interface BashVerdict {
  risk: RiskClass;
  /** Effect tool to name in the denial reason; undefined for an unknown command. */
  use?: string;
  /** The command is on the list (an unknown one is not). */
  listed?: true;
}

/** The unknown verdict: destructive until granted. */
const UNKNOWN: BashVerdict = { risk: "R2" };

/** Shells that may run a script file (`bash <script>`); `-c` and stdin forms are never listed. */
const SHELLS = new Set(["bash", "sh", "zsh"]);

/**
 * True when `path` is a script the run may execute: absolute, resolvable, inside a SKILL plugin dir (`skillDirs`, read-only,
 * under the agent home) and NOT inside a dir the agent can write (it could write its own script).
 */
function isSkillScript(path: string, ctx: GuardrailContext): boolean {
  if (!isAbsolute(path)) return false;
  const real = realOrSame(path);
  return (
    (ctx.skillDirs ?? []).some((d) => isInside(realOrSame(d), real)) &&
    !writeRoots(ctx).some((w) => isInside(w, real))
  );
}

/** True when every argument of a skill script is a flag or lies inside the write dirs (`--out=<path>` is judged by its value). */
function scriptArgsOk(args: string[], ctx: GuardrailContext): boolean {
  const roots = writeRoots(ctx);
  return args.every((a) => {
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (a.startsWith("-") && eq < 0) return true; // a bare flag: its value is the next word, judged on its own
    return pathGranted(eq < 0 ? a : a.slice(eq + 1), ctx, roots);
  });
}

/**
 * Class of a whole Bash line. Only ONE simple command of plain words can be listed; a line with an operator, redirect,
 * quote, expansion or any char outside the allowed alphabet is unknown (R2), as is every unlisted command, subcommand, flag,
 * value or path. `sh -c`, interpreters, `env`, `xargs`, `cd` and path invocations are simply not in the table.
 */
export function classifyBash(command: string, ctx: GuardrailContext): BashVerdict {
  const shaped = shapeOf(command);
  if (!shaped) return UNKNOWN;
  const { words, revWords } = shaped;
  if (!revWordsOk(words, revWords, ctx.cwd)) return UNKNOWN;
  // A path invocation (`/skill/run.sh`, `bash /skill/run.sh`): only a script of a read-only granted dir (a skill) runs.
  const script =
    SHELLS.has(words[0]) && words[1] && !words[1].startsWith("-") ? words[1] : words[0];
  if (script.includes("/") || script !== words[0]) {
    const args = words.slice(script === words[0] ? 1 : 2);
    return isSkillScript(script, ctx) && scriptArgsOk(args, ctx)
      ? { risk: "R1", listed: true }
      : UNKNOWN;
  }
  const hit = matchCommand(words);
  if (!hit) return UNKNOWN;
  const { entry, rest } = hit;
  const risk = entry.class ?? "R0";
  // An effect-tool replacement (rm, git push, git merge, gh pr create) is never run from the shell: named, not parsed.
  if (entry.use) return { risk, listed: true, use: entry.use };
  const checked = checkArgs(entry, rest);
  const paths = checked && gitPaths(words, checked, ctx);
  if (!paths) return UNKNOWN;
  const fs = entry.fs ?? "none";
  if (fs !== "none") {
    const roots = fs === "write" ? writeRoots(ctx) : readRoots(ctx);
    if (!cwdGranted(ctx, roots) || !paths.every((p) => pathGranted(p, ctx, roots))) return UNKNOWN;
  }
  return { risk, listed: true };
}
