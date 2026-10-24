import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveReal } from "../../effects/workspace-paths";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, need, Refused, replaceDir, skillFront, toYaml } from "../design-util";
import { refuseExisting, skillName } from "./write-skill";

/** Most files and bytes of an installed skill. */
export const INSTALL_MAX_FILES = 100;
export const INSTALL_MAX_BYTES = 2 * 1024 * 1024;
/** The version-control dir of a clone is never copied; at the skill root it is skipped, deeper it is refused. */
const VCS_DIR = ".git";

/**
 * The bytes of one file, opened without following a link and checked on the open handle (the clone is in the bot's
 * scratch dir, so a background process of the bot may swap a file or a parent dir for a link between the checks). The
 * parent dir must still resolve inside the skill dir after the read.
 */
function readFileNoFollow(path: string, root: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Refused(`a link or unreadable file is not copied: ${relative(root, path)}`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Refused(`not a regular file: ${relative(root, path)}`);
    const data = readFileSync(fd);
    const parent = relative(realpathSync(root), realpathSync(join(path, "..")));
    if (parent === ".." || parent.startsWith(`..${sep}`) || isAbsolute(parent))
      throw new Refused(`the file moved out of the skill dir: ${relative(root, path)}`);
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under `root` as rel path → bytes; refuses links, other file kinds, a VCS dir and oversize. */
function collect(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      const rel = relative(root, path).split(sep).join("/");
      if (e.name === VCS_DIR) {
        if (dir === root) continue;
        throw new Refused(`the skill holds a ${VCS_DIR} dir: ${rel}`);
      }
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Refused(`a link is not copied: ${rel}`);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        bytes += st.size;
        if (out.size + 1 > INSTALL_MAX_FILES || bytes > INSTALL_MAX_BYTES)
          throw new Refused(
            `over ${INSTALL_MAX_FILES} files or ${INSTALL_MAX_BYTES / 1024 / 1024} MB.`,
          );
        out.set(rel, readFileNoFollow(path, root));
      } else throw new Refused(`not a regular file: ${rel}`);
    }
  };
  walk(root);
  return out;
}

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
  const files = collect(real);
  const front = skillFront(files.get("SKILL.md")?.toString("utf8") ?? "");
  if (front.name !== name)
    throw new Refused(`the SKILL.md name is "${front.name ?? ""}", not "${name}".`);
  if (!front.description) throw new Refused("SKILL.md has no description.");
  refuseExisting(ctx, name, a.overwrite);
  const sha = (await ctx.gitHead(real)) ?? "unknown";
  replaceDir(join(ctx.configDir, "skills", name), files);
  // The lock records where each installed skill came from; a hand edit is kept, only this entry changes.
  const lockFile = join(ctx.configDir, "skills", "skills.lock.yaml");
  const lock = existsSync(lockFile)
    ? ((Bun.YAML.parse(readFileSync(lockFile, "utf8")) as Record<string, unknown> | null) ?? {})
    : {};
  atomicWrite(lockFile, toYaml({ ...lock, [name]: { source, sha } }));
  return `Installed skill ${name} (${files.size} files) from ${source} at ${sha}.`;
}
