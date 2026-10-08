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
import { logEvent, logger } from "../observability/logger";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "clone-skill-plugin" });

/**
 * Caps on the copied skills (repo content is remote-controlled): per repo, and per run over all repos.
 * `files` counts every entry (files AND directories, empty ones included); `MAX_DEPTH` bounds nesting.
 */
const REPO_CAP = { files: 300, bytes: 5 * 1024 * 1024 };
const RUN_CAP = { files: 1000, bytes: 15 * 1024 * 1024 };
const MAX_DEPTH = 8;

/** Stale plugin dirs (left by a crash) older than this are swept at startup. */
const STALE_PLUGIN_MS = 60 * 60 * 1000;
/** Prefix of every plugin dir the app creates under `<home>/tmp`. */
const PLUGIN_PREFIX = "plugin-";

/** A repo whose `.claude/skills` may be offered to the run (a trusted, app-refreshed clone, never a worktree). */
export interface SkillRepo {
  name: string;
  path: string;
}

/** Skills + plugin options of one run, and the cleanup of the plugin dirs the app created for it. */
export interface RunSkills {
  skills: string[];
  plugins?: NonNullable<Options["plugins"]>;
  /** Real paths of the plugin dirs of THIS run: the guard may let the run READ them (bundled skill files). */
  dirs: string[];
  /** Removes the app-owned plugin dirs (no-op when none was created). */
  cleanup: () => void;
}

/** One built plugin and what it cost. */
interface BuiltPlugin {
  dir: string;
  skills: string[];
  files: number;
  bytes: number;
}

/** Plugin name = the repo name reduced to a safe token (it prefixes the qualified skill names). */
const pluginName = (repo: string): string =>
  repo.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "repo";

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
 * App-owned plugin of one repo: a fresh dir under `<agentHome>/tmp` holding ONLY an app-written manifest
 * (name = repo) and a copy of `<repo>/.claude/skills`. The repo's hooks, .mcp.json, agents, commands and
 * settings are never copied, so repo content cannot run code outside the guard. Fails closed (undefined,
 * dir removed) on a symlinked/outside skills dir, a cap hit or any IO error; a missing skills dir is silent.
 */
function buildRepoPlugin(
  repo: SkillRepo,
  name: string,
  agentHome: string,
  limits: { files: number; bytes: number },
): BuiltPlugin | undefined {
  let root: string | undefined;
  try {
    const skillsSrc = realpathSync(join(repo.path, ".claude", "skills"));
    // A symlinked .claude or skills dir that leaves the repo is refused outright.
    if (!skillsSrc.startsWith(realpathSync(repo.path) + sep)) return undefined;
    const base = join(agentHome, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(base, PLUGIN_PREFIX));
    const dir = root;
    mkdirSync(join(dir, ".claude-plugin"), { mode: 0o700 });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    const budget = { files: 0, bytes: 0, maxFiles: limits.files, maxBytes: limits.bytes };
    copySkillTree(skillsSrc, join(dir, "skills"), budget);
    const skills = readdirSync(join(dir, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md")))
      .map((e) => `${name}:${e.name}`);
    if (!skills.length) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    return { dir: realpathSync(dir), skills, files: budget.files, bytes: budget.bytes };
  } catch (err) {
    if (root) rmSync(root, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ repo: repo.name, err: String(err) }, "repo skills not loaded");
    }
    return undefined;
  }
}

/**
 * Skills option of a run: the ONLY way repo skills reach any mode (settingSources is always []). One plugin
 * per repo of the run's repo set, named after the repo (skills `<repo>:<skill>`); `skills` lists exactly their
 * qualified names so the SDK's bundled skills stay hidden. Per-repo caps 300 entries / 5 MB, per-run caps
 * 1000 files / 15 MB: a repo over a cap gets no plugin and a warn. Logs `skills.plugin_built`.
 */
export function runSkills(repos: SkillRepo[] | undefined, agentHome: string): RunSkills {
  const started = Date.now();
  const built: BuiltPlugin[] = [];
  const names = new Map<string, string>(); // plugin name -> repo that owns it
  const builtRepos: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const repo of repos ?? []) {
    const name = pluginName(repo.name);
    // Two repos sanitizing/truncating to one name: never let one shadow the other, and say so.
    const owner = names.get(name);
    if (owner !== undefined) {
      log.warn(
        { repo: repo.name, other: owner, name },
        "repo skills skipped: plugin name collision",
      );
      continue;
    }
    const p = buildRepoPlugin(repo, name, agentHome, {
      files: Math.min(REPO_CAP.files, RUN_CAP.files - files),
      bytes: Math.min(REPO_CAP.bytes, RUN_CAP.bytes - bytes),
    });
    if (!p) continue;
    names.set(name, repo.name); // reserved only after a successful build
    built.push(p);
    builtRepos.push(repo.name);
    files += p.files;
    bytes += p.bytes;
  }
  if (!built.length) return { skills: [], dirs: [], cleanup: () => {} };
  logEvent(log, "skills.plugin_built", {
    repos: builtRepos,
    files,
    bytes,
    ms: Date.now() - started,
  });
  return {
    plugins: built.map((p) => ({ type: "local" as const, path: p.dir })),
    skills: built.flatMap((p) => p.skills),
    dirs: built.map((p) => p.dir),
    cleanup: () => {
      for (const p of built) rmSync(p.dir, { recursive: true, force: true });
    },
  };
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
