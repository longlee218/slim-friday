import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
 * Caps on the copied skills (owner-curated, but still bounded). `files` counts every entry (files AND
 * directories, empty ones included); `MAX_DEPTH` bounds nesting.
 */
const CAP = { files: 300, bytes: 5 * 1024 * 1024 };
const MAX_DEPTH = 8;

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

/**
 * Copy regular files/dirs of `src` to `dst`. Symlinks are skipped (their target may live anywhere), and the
 * walk throws past the limits. `budget` counts files/bytes and is shared across the recursion.
 */
function copySkillTree(
  src: string,
  dst: string,
  budget: { files: number; bytes: number; maxFiles: number; maxBytes: number },
  depth = 0,
): void {
  if (depth > MAX_DEPTH) throw new Error("skills nested too deep");
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    const st = lstatSync(from); // lstat: never follow
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      budget.files++; // directories count too: an empty-dir bomb is as costly as files
      if (budget.files > budget.maxFiles) throw new Error("skills too large");
      copySkillTree(from, to, budget, depth + 1);
    } else if (st.isFile()) {
      budget.files++;
      budget.bytes += st.size;
      if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
        throw new Error("skills too large");
      }
      copyFileSync(from, to);
    }
  }
}

/**
 * Skills option of a run: the ONLY source of skills in every mode (settingSources is always [] and repo
 * `.claude/skills` is never read). One app-owned plugin built from `workspaces/<ws>/skills` of the run's
 * workspace, named after the workspace (skills `<ws>:<skill>`); `skills` lists exactly those qualified names so
 * the SDK's bundled skills stay hidden. The plugin is a fresh dir under `<agentHome>/tmp` holding ONLY an
 * app-written manifest and a copy of the skills dir: symlinks are skipped, no hooks/.mcp.json/agents/commands/
 * settings exist in it. Caps 300 entries / 5 MB, depth 8: over a cap or on any IO error it fails closed (no
 * plugin, dir removed, warn). A missing/empty skills dir is the normal case (debug log only).
 * Logs `skills.plugin_built`.
 */
export function workspaceSkills(workspace: string | undefined, agentHome: string): RunSkills {
  const none: RunSkills = { skills: [], dirs: [], cleanup: () => {} };
  if (!workspace) return none;
  const started = Date.now();
  const wsDirs = workspacePaths(agentHome).workspace(workspace);
  let root: string | undefined;
  try {
    const src = realpathSync(wsDirs.skills);
    // A symlinked skills dir that leaves the workspace is refused outright.
    if (!src.startsWith(realpathSync(wsDirs.root) + sep)) return none;
    const base = join(agentHome, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(base, PLUGIN_PREFIX));
    const dir = root;
    mkdirSync(join(dir, ".claude-plugin"), { mode: 0o700 });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: workspace }));
    const budget = { files: 0, bytes: 0, maxFiles: CAP.files, maxBytes: CAP.bytes };
    copySkillTree(src, join(dir, "skills"), budget);
    const skills = readdirSync(join(dir, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md")))
      .map((e) => `${workspace}:${e.name}`);
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
