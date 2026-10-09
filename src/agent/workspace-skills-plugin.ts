import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "workspace-skills-plugin" });

/**
 * Caps (owner-curated, but still bounded). `files` counts every entry (files AND directories, empty ones
 * included). Per skill: a skill over its cap is skipped alone. Total: the whole skills dir; over it nothing
 * loads (outer fail-closed limit). `MAX_DEPTH` bounds nesting inside the skills dir.
 */
const SKILL_CAP = { files: 100, bytes: 2 * 1024 * 1024 };
const TOTAL_CAP = { files: 300, bytes: 5 * 1024 * 1024 };
const MAX_DEPTH = 8;
/** Dirs never copied from inside a skill (dependency/VCS trees, huge and useless to a skill). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** A usable skill name (the frontmatter name is only trusted when it looks like this). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Stale plugin dirs (left by a crash) older than this are swept at startup. */
const STALE_PLUGIN_MS = 60 * 60 * 1000;
/** Prefix of every plugin dir the app creates under `<home>/tmp`. */
const PLUGIN_PREFIX = "plugin-";

/** Skills + plugin options of one run, and the cleanup of the plugin dir the app created for it. */
export interface RunSkills {
  skills: string[];
  plugins?: NonNullable<Options["plugins"]>;
  /** Real path of the plugin dir of THIS run: the guard may let the run READ it (bundled skill files). */
  dirs: string[];
  /** Removes the app-owned plugin dir (no-op when none was created). */
  cleanup: () => void;
}

/** Budget of one copy walk: counters plus the limits they are checked against. */
interface Budget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

/**
 * Copy regular files/dirs of `src` to `dst`. Symlinks and `node_modules`/VCS dirs are skipped (a symlink
 * target may live anywhere). Throws `Error(reason)` past the limits. `budget` is shared across the recursion.
 */
function copySkillTree(src: string, dst: string, budget: Budget, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    const st = lstatSync(from); // lstat: never follow
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        log.debug({ dir: e.name }, "skill subdir skipped");
        continue;
      }
      budget.files++; // directories count too: an empty-dir bomb is as costly as files
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      copySkillTree(from, to, budget, depth + 1);
    } else if (st.isFile()) {
      budget.files++;
      budget.bytes += st.size;
      if (budget.files > budget.maxFiles) throw new Error("too many entries");
      if (budget.bytes > budget.maxBytes) throw new Error("too big");
      copyFileSync(from, to);
    }
  }
}

/** `name:` of the first `---` frontmatter block of a SKILL.md, or undefined (missing/invalid). */
function frontmatterName(skillFile: string): string | undefined {
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
 * Skills option of a run: the ONLY source of skills in every mode (settingSources is always [] and repo
 * `.claude/skills` is never read). One app-owned plugin built from `workspaces/<ws>/skills` of the run's
 * workspace, named after the workspace (skills `<ws>:<skill>`); `skills` lists exactly those qualified names so
 * the SDK's bundled skills stay hidden. The plugin is a fresh dir under `<agentHome>/tmp` holding ONLY an
 * app-written manifest and a copy of the skills dir: symlinks are skipped, no hooks/.mcp.json/agents/commands/
 * settings exist in it. Caps per skill 100 entries / 2 MB, depth 8 (an offending skill is skipped alone with a
 * warn); whole dir 300 entries / 5 MB, over it or on an IO error nothing loads (fail closed, warn). A missing/empty skills dir is the normal case (debug log only).
 * Logs `skills.plugin_built`.
 */
export function workspaceSkills(workspace: string | undefined, agentHome: string): RunSkills {
  const none: RunSkills = { skills: [], dirs: [], cleanup: () => {} };
  if (!workspace) return none;
  const started = Date.now();
  const wsDirs = workspacePaths(agentHome).workspace(workspace);
  let root: string | undefined;
  try {
    // A symlinked skills dir is refused outright: it could point at a repo's skills dir.
    if (lstatSync(wsDirs.skills).isSymbolicLink()) {
      log.warn({ workspace }, "workspace skills dir is a symlink: no skills loaded");
      return none;
    }
    const src = realpathSync(wsDirs.skills);
    if (!src.startsWith(realpathSync(wsDirs.root) + sep)) return none;
    const base = join(agentHome, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(base, PLUGIN_PREFIX));
    const dir = root;
    mkdirSync(join(dir, ".claude-plugin"), { mode: 0o700 });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: workspace }));
    const budget = { files: 0, bytes: 0 };
    const skills: string[] = [];
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, e.name);
      if (!lstatSync(from).isDirectory()) continue; // files and symlinks at the top are not skills
      if (!existsSync(join(from, "SKILL.md"))) {
        log.debug({ skill: `${workspace}:${e.name}` }, "skill dir without SKILL.md skipped");
        continue;
      }
      // Per-skill budget: an offending skill is dropped alone, the others still load.
      const to = join(dir, "skills", e.name);
      const one = {
        files: 1,
        bytes: 0, // the skill dir itself counts
        maxFiles: SKILL_CAP.files,
        maxBytes: SKILL_CAP.bytes,
      };
      try {
        copySkillTree(from, to, one, 1); // depth 1: the skill dir sits one level below skills/
      } catch (err) {
        rmSync(to, { recursive: true, force: true });
        log.warn(
          { skill: `${workspace}:${e.name}`, reason: (err as Error).message },
          "skill skipped",
        );
        continue;
      }
      budget.files += one.files;
      budget.bytes += one.bytes;
      if (budget.files > TOTAL_CAP.files || budget.bytes > TOTAL_CAP.bytes) {
        throw new Error(`workspace skills over the total cap at ${workspace}:${e.name}`);
      }
      // The SDK may key a skill by its frontmatter name; the allowlist must use the same key.
      const fm = frontmatterName(join(to, "SKILL.md"));
      if (fm && fm !== e.name) {
        log.debug({ dir: e.name, name: fm }, "skill frontmatter name differs from dir name");
      }
      skills.push(`${workspace}:${fm ?? e.name}`);
    }
    if (!skills.length) {
      rmSync(dir, { recursive: true, force: true });
      log.debug({ workspace }, "workspace has no skills");
      return none;
    }
    const real = realpathSync(dir);
    logEvent(log, "skills.plugin_built", {
      workspace,
      skills: skills.length,
      files: budget.files,
      bytes: budget.bytes,
      ms: Date.now() - started,
    });
    return {
      plugins: [{ type: "local" as const, path: real }],
      skills,
      dirs: [real],
      cleanup: () => rmSync(real, { recursive: true, force: true }),
    };
  } catch (err) {
    if (root) rmSync(root, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug({ workspace }, "workspace has no skills dir");
    } else {
      log.warn({ workspace, err: String(err) }, "workspace skills not loaded");
    }
    return none;
  }
}

/**
 * Startup sweep: remove `<home>/tmp/plugin-*` dirs older than an hour (a crash skipped their cleanup).
 * Only that prefix, only direct children of `<home>/tmp`, only real directories (symlinks are never followed).
 */
export function sweepStalePlugins(agentHome: string, now = Date.now()): number {
  const base = join(agentHome, "tmp");
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return 0; // no tmp dir yet
  }
  for (const name of names) {
    if (!name.startsWith(PLUGIN_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < STALE_PLUGIN_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn({ dir, err: String(err) }, "stale plugin dir not removed");
    }
  }
  if (removed) logEvent(log, "skills.plugins_swept", { removed });
  return removed;
}
