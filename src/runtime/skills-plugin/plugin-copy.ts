import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "../../observability/logger";

/** Logger of this module group. */
export const log = logger.child({ module: "skills-plugin" });

/** Entry/byte limits of one copy walk. `files` counts every entry (files AND directories, empty ones included). */
interface Caps {
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

/** `MAX_DEPTH` bounds nesting inside a skills dir. */
const MAX_DEPTH = 8;
/** Dirs never copied from inside a skill (dependency/VCS trees, huge and useless to a skill). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/**
 * Names never copied at any depth: Claude Code config (hooks, MCP servers, settings) must not ride into the plugin
 * inside a skill dir. The plugin root itself is app-written and holds only the manifest.
 */
const SKIP_NAMES = new Set([".claude", ".claude-plugin", "hooks", "hooks.json", ".mcp.json"]);
/** Largest single file copied; a bigger one fails its skill (it is skipped alone, with a warn). */
const MAX_FILE_BYTES = 1024 * 1024;
/** A usable skill name (the frontmatter name is only trusted when it looks like this). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Executable bit of a copied file whose source had one (skill scripts keep it). */
const EXEC_BITS = 0o111;

/**
 * Copy regular files/dirs of `src` to `dst`, whole and unmodified (contents and exec bit). Symlinks, other special
 * files, `node_modules`/VCS dirs and config names (`SKIP_NAMES`) are skipped (a symlink target may live anywhere).
 * Throws `Error(reason)` past the limits (entries, bytes, one file's size, depth). `budget` is shared across the recursion.
 */
export function copySkillTree(src: string, dst: string, budget: Budget, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    const st = lstatSync(from); // lstat: never follow
    if (st.isSymbolicLink()) continue;
    if (SKIP_NAMES.has(e.name)) {
      log.warn({ name: e.name, rel: from }, "skill entry skipped (Claude config name)");
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        log.debug({ dir: e.name }, "skill subdir skipped");
        continue;
      }
      budget.files++; // directories count too: an empty-dir bomb is as costly as files
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      copySkillTree(from, to, budget, depth + 1);
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) throw new Error("file too big");
      budget.files++;
      budget.bytes += st.size;
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      if (budget.bytes > budget.maxBytes) throw new Error("too big");
      copyFileSync(from, to); // modes are fixed by `lockTree` once the plugin is complete
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

/**
 * Make a finished plugin read-only: executable files 0555, other files 0444, dirs 0555 (symlinks are never present).
 * A skill script run with a model-chosen path argument can then not overwrite a script of the plugin (which would run
 * later with every hard deny out of sight). Children first, so a dir is locked after its content is.
 */
export function lockTree(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) lockTree(p);
    else if (e.isFile()) chmodSync(p, lstatSync(p).mode & EXEC_BITS ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

/** Remove a plugin tree, also a locked one (dirs are made writable again first; symlinks are never followed). */
export function removeTree(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) {
      chmodSync(path, 0o700);
      for (const e of readdirSync(path)) removeTree(join(path, e));
    }
  } catch {
    // missing or unreadable: rmSync below decides (force ignores a missing path)
  }
  rmSync(path, { recursive: true, force: true });
}
