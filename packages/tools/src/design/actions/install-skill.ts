import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveReal } from "../../effects/workspace-paths";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { need, Refused } from "../design-util";
import { installFromStaged } from "./install-from-staged";
import { refuseExisting, skillName } from "./write-skill";

/** True when `real` is strictly inside `root`. */
function strictlyInside(root: string, real: string): boolean {
  const r = relative(resolveReal(root), real);
  return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

/**
 * `install_skill`: copy a skill dir the bot cloned into its scratch dir to `<config>/skills/<name>/`, and record
 * where it came from. The files are checked again here; nothing in them is run.
 */
export async function installSkill(ctx: DesignContext, a: DesignArgs): Promise<string> {
  const name = skillName(a.id);
  const from = need(a.from, "from");
  const source = need(a.source, "source");
  if (!isAbsolute(from)) throw new Refused("from must be an absolute path.");
  let real: string;
  try {
    real = resolveReal(from);
  } catch {
    throw new Refused(`cannot read: ${from}`);
  }
  if (!strictlyInside(ctx.scratchDir, real))
    throw new Refused("the skill dir must lie inside your scratch dir.");
  if (!existsSync(join(real, "SKILL.md"))) throw new Refused("SKILL.md not found in that dir.");
  // Refuse before the move, so a refused call leaves the clone where it is.
  refuseExisting(ctx, name, a.overwrite);
  // Move the dir to a place the bot cannot write, so a background process of the bot cannot swap a file or a parent
  // dir for a link while it is read. The sha is taken first: the clone's history stays behind.
  const sha = (await ctx.gitHead(real)) ?? "unknown";
  const staging = join(ctx.configDir, ".staging", `${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  renameSync(real, staging);
  try {
    const files = installFromStaged(ctx, {
      stagedDir: staging,
      name,
      source,
      sha,
      overwrite: !!a.overwrite,
    });
    return `Installed skill ${name} (${files} files) from ${source} at ${sha}.`;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
