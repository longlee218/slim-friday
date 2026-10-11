import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../observability/logger";

/** Logger of this module group. */
export const log = logger.child({ module: "skills-plugin" });

/** Entry/byte limits of one copy walk. `files` counts every entry (files AND directories, empty ones included). */
export interface Caps {
  files: number;
  bytes: number;
}

/** Caps of one plugin: per skill (an offending skill is skipped alone) and for the whole skills dir (over it nothing loads). */
export interface PluginCaps {
  skill: Caps;
  total: Caps;
}

/** Budget of one copy walk: counters plus the limits they are checked against. */
export interface Budget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

/**
 * Decides whether a regular file is copied: `rel` is its path under the skills dir (posix, `<skill>/...`), `abs` its
 * real source path. Omitted = every regular file is copied (the owner-curated workspace dir).
 */
export type FileFilter = (rel: string, abs: string) => boolean;

/** `MAX_DEPTH` bounds nesting inside a skills dir. */
const MAX_DEPTH = 8;
/** Dirs never copied from inside a skill (dependency/VCS trees, huge and useless to a skill). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** A usable skill name (the frontmatter name is only trusted when it looks like this). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Executable bit of a copied file whose source had one (vendored SDD scripts). */
const EXEC_BITS = 0o111;

/**
 * Copy regular files/dirs of `src` to `dst`. Symlinks and `node_modules`/VCS dirs are skipped (a symlink target may
 * live anywhere); a `filter` may skip more. Throws `Error(reason)` past the limits. `budget` is shared across the
 * recursion; `rel` is the path of `src` under the skills dir (for the filter).
 */
export function copySkillTree(
  src: string,
  dst: string,
  budget: Budget,
  rel: string,
  filter?: FileFilter,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    const childRel = `${rel}/${e.name}`;
    const st = lstatSync(from); // lstat: never follow
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        log.debug({ dir: e.name }, "skill subdir skipped");
        continue;
      }
      budget.files++; // directories count too: an empty-dir bomb is as costly as files
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      copySkillTree(from, to, budget, childRel, filter, depth + 1);
    } else if (st.isFile()) {
      if (filter && !filter(childRel, from)) continue;
      budget.files++;
      budget.bytes += st.size;
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      if (budget.bytes > budget.maxBytes) throw new Error("too big");
      copyFileSync(from, to);
      if (st.mode & EXEC_BITS) chmodSync(to, 0o755); // owner-only dir, so 755 inside is not exposed
    }
  }
}

/** `name:` of the first `---` frontmatter block of a SKILL.md, or undefined (missing/invalid). */
export function frontmatterName(skillFile: string): string | undefined {
  try {
    const head = readFileSync(skillFile, "utf8").slice(0, 4096);
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const raw = m && /^name:[ \t]*(.+?)[ \t]*$/m.exec(m[1] ?? "")?.[1];
    const name = raw?.replace(/^["']|["']$/g, "");
    return name && SKILL_NAME.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
