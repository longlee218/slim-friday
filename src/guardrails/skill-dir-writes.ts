import { basename, isAbsolute, join } from "node:path";
import type { Segment } from "./bash-parser";
import { realIn } from "./skill-script";

/** Commands that write to EVERY path argument (the target of chmod/rm/tee... is any of them). */
const WRITES_ANY = new Set([
  "chmod",
  "chown",
  "chgrp",
  "mv",
  "tee",
  "rm",
  "touch",
  "truncate",
  "sed",
]);
/** Commands whose target is the LAST path argument (`cp SRC DST`); the sources are only read. */
const WRITES_LAST = new Set(["cp", "install", "ln", "rsync"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "builtin"]);

/**
 * Hard deny (for every agent, whatever the permission mode: under bypass an ask would run) of a command that would
 * change a file inside the run's skill dirs: chmod/chown/mv/rm/tee/touch/cp/ln/install..., or a redirect (`>`, `>>`)
 * whose target (the word after the operator, `redirectTargets`) is there. The read-only modes of the built plugin are only a speed bump (the owner
 * of the files can chmod them back); this rule is the barrier. Returns the reason or undefined.
 */
export function writesSkillDir(
  seg: Segment,
  cwd: string | undefined,
  skillDirs: readonly string[] | undefined,
): string | undefined {
  if (!skillDirs?.length) return undefined;
  const words = [...seg.words];
  while (
    words.length &&
    (/^[A-Za-z_]\w*=/.test(words[0] as string) || WRAPPERS.has(basename(words[0] as string)))
  )
    words.shift();
  const cmd = basename(words[0] ?? "");
  const paths = words.slice(1).filter((w) => !w.startsWith("-") && w !== "");
  const targets = WRITES_ANY.has(cmd) ? paths : WRITES_LAST.has(cmd) ? paths.slice(-1) : [];
  targets.push(...seg.redirectTargets); // every `>` / `>>` / `&>` / `N>` target, wherever it sits in the line
  // A relative target with an unknown cwd cannot be placed: treat it as inside (deny).
  const inside = (w: string) => {
    const abs = isAbsolute(w) ? w : cwd ? join(cwd, w) : undefined;
    return !abs || realIn(skillDirs, abs);
  };
  return targets.some(inside) ? "writing to a skill directory is blocked" : undefined;
}
