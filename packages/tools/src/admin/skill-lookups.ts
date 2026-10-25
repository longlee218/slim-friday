import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Refused, SKILL_NAME_RE, skillFront } from "../design/design-util";

/** How long a lookup stays valid, in ms. */
export const LOOKUP_TTL_MS = 15 * 60_000;

/** A skill found in a clone: its name, its dir relative to the clone root ("." for the root) and what it holds. */
export interface FoundSkill {
  name: string;
  description: string;
  /** Dir of the skill relative to the clone root. */
  rel: string;
  files: string[];
  scripts: string[];
}

/** One lookup kept in memory until it is used or expires. */
export interface LookupState {
  dir: string;
  source: string;
  path?: string;
  sha: string;
  skills: FoundSkill[];
  expiresAt: number;
}

/** True when `real` lies inside `root` (or is it). */
function within(root: string, real: string): boolean {
  const r = relative(root, real);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * The skill dir `path` names inside the clone: it must exist, not be a link, and its real path must stay under the
 * clone's real path (a link in the middle of the path would lead out). Refuses with field `path`.
 */
export function resolveSkillPath(cloneDir: string, path: string): string {
  const target = join(cloneDir, path);
  try {
    if (lstatSync(target).isSymbolicLink())
      throw new Refused("path must not be a symlink.", "path");
    if (!within(realpathSync(cloneDir), realpathSync(target)))
      throw new Refused("path must stay inside the repo.", "path");
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused("path does not exist in the repo.", "path", e);
  }
  return target;
}

/** Files of a skill dir (relative, `/` separated; links are listed, never entered; the root `.git` is skipped) and the scripts among them. */
function describeFiles(dir: string): { files: string[]; scripts: string[] } {
  const files: string[] = [];
  const scripts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (d === dir && e.name === ".git") continue;
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(dir, p).split(sep).join("/");
      files.push(rel);
      if (/\.(sh|py|js|ts)$/.test(e.name) || st.mode & 0o111) scripts.push(rel);
    }
  };
  walk(dir);
  return { files: files.sort(), scripts: scripts.sort() };
}

/** The skill in `dir` (a `SKILL.md` with a valid name), or undefined. */
function readSkill(cloneDir: string, dir: string): FoundSkill | undefined {
  const file = join(dir, "SKILL.md");
  try {
    if (!lstatSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const front = skillFront(readFileSync(file, "utf8"));
  if (!front.name || !SKILL_NAME_RE.test(front.name) || !front.description) return undefined;
  const rel = relative(cloneDir, dir).split(sep).join("/") || ".";
  return { name: front.name, description: front.description, rel, ...describeFiles(dir) };
}

/**
 * The skills of a clone: `path` given: that dir only; else the root when it has `SKILL.md`, else `skills/*` and `*`.
 * Refuses with a field when nothing is found.
 */
export function findSkills(cloneDir: string, path?: string): FoundSkill[] {
  if (path !== undefined) {
    const s = readSkill(cloneDir, resolveSkillPath(cloneDir, path));
    if (!s)
      throw new Refused(
        "no valid skill (SKILL.md with name and description) at that path.",
        "path",
      );
    return [s];
  }
  const root = readSkill(cloneDir, cloneDir);
  if (root) return [root];
  const found = new Map<string, FoundSkill>();
  for (const parent of [join(cloneDir, "skills"), cloneDir]) {
    if (!existsSync(parent)) continue;
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const s = readSkill(cloneDir, join(parent, e.name));
      if (s && !found.has(s.name)) found.set(s.name, s);
    }
  }
  if (found.size === 0)
    throw new Refused("no skill (SKILL.md with name and description) found in the repo.", "source");
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a lookup dir; never throws. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Sweep `lookupDir`: expired lookups leave memory and disk; any other entry (a `clone-*` temp dir or a lookup of an
 * earlier run) older than the TTL is removed too. Younger entries may belong to a clone in flight and stay.
 */
export function sweepLookups(
  lookupDir: string,
  memory: Map<string, LookupState>,
  now: number,
): void {
  const live = new Set<string>();
  for (const [id, l] of memory) {
    if (l.expiresAt <= now) {
      removeDir(l.dir);
      memory.delete(id);
    } else live.add(l.dir);
  }
  for (const name of readdirSync(lookupDir)) {
    const p = join(lookupDir, name);
    if (live.has(p)) continue;
    try {
      if (now - statSync(p).mtimeMs > LOOKUP_TTL_MS) removeDir(p);
    } catch {
      // gone already
    }
  }
}
