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
import { insideConfig } from "../../admin/config-paths";
import type { DesignContext } from "../design-context";
import { atomicWrite, Refused, replaceDir, skillFront, toYaml } from "../design-util";
import { refuseExisting } from "./write-skill";

/** Most files and bytes of an installed skill. */
export const INSTALL_MAX_FILES = 100;
export const INSTALL_MAX_BYTES = 2 * 1024 * 1024;
/** The version-control dir of a clone is never copied; at the skill root it is skipped, deeper it is refused. */
const VCS_DIR = ".git";

/** One entry of `skills.lock.yaml`: where an installed skill came from and when. */
export interface SkillLockEntry {
  source: string;
  path?: string;
  sha?: string;
  installedAt?: string;
}

/** The lock file of `<config>/skills/`. */
export const skillLockFile = (configDir: string): string =>
  join(configDir, "skills", "skills.lock.yaml");

/** The lock as a map (a missing or unreadable file is an empty lock; a hand edit is kept). */
export function readSkillLock(configDir: string): Record<string, unknown> {
  const file = skillLockFile(configDir);
  if (!existsSync(file)) return {};
  try {
    return (Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

/**
 * The bytes of one file, opened without following a link and checked on the open handle (the clone is in a dir a
 * background process may write to, so a file or a parent dir may be swapped for a link between the checks). The
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

/**
 * Install a skill dir that already lies where the bot or a lookup cannot change it: check the files (100 files, 2 MB,
 * no links, `SKILL.md` name = `name`, a description), replace `<config>/skills/<name>/` and write the lock entry
 * (source, path, sha, install time). Returns the file count. A shipped name is always refused; an existing owner
 * skill is refused unless `overwrite`.
 */
export function installFromStaged(
  ctx: DesignContext,
  i: {
    stagedDir: string;
    name: string;
    source: string;
    path?: string;
    sha: string;
    overwrite: boolean;
  },
): number {
  refuseExisting(ctx, i.name, i.overwrite);
  const files = collect(i.stagedDir);
  const front = skillFront(files.get("SKILL.md")?.toString("utf8") ?? "");
  if (front.name !== i.name)
    throw new Refused(`the SKILL.md name is "${front.name ?? ""}", not "${i.name}".`);
  if (!front.description) throw new Refused("SKILL.md has no description.");
  replaceDir(insideConfig(ctx.configDir, join(ctx.configDir, "skills", i.name)), files);
  // The lock records where each installed skill came from; a hand edit is kept, only this entry changes.
  const entry: SkillLockEntry = {
    source: i.source,
    ...(i.path !== undefined && { path: i.path }),
    sha: i.sha,
    installedAt: new Date(ctx.now()).toISOString(),
  };
  const lock = { ...readSkillLock(ctx.configDir), [i.name]: entry };
  atomicWrite(insideConfig(ctx.configDir, skillLockFile(ctx.configDir)), toYaml(lock));
  return files.size;
}
