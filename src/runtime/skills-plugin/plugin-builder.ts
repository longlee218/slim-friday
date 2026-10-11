import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { logEvent } from "../../observability/logger";
import {
  copySkillTree,
  frontmatterName,
  lockTree,
  log,
  type PluginCaps,
  removeTree,
} from "./plugin-copy";
import { PLUGIN_PREFIX } from "./plugin-sweep";

/** Skills + plugin options of one run, and the cleanup of the plugin dirs the app created for it. */
export interface RunSkills {
  skills: string[];
  plugins?: NonNullable<Options["plugins"]>;
  /** Real paths of the plugin dirs of THIS run: the guard may let the run READ them (bundled skill files). */
  dirs: string[];
  /** Subset of `dirs` whose scripts may run from Bash (the publisher's pinned skills); a workspace dir is only readable. */
  scriptDirs: string[];
  /** Removes the app-owned plugin dirs (no-op when none was created). */
  cleanup: () => void;
}

/** What one plugin is built from. */
export interface PluginSpec {
  /** Plugin name: the skills of it are `<name>:<skill>`. */
  name: string;
  /** `workspace` (owner dir, logs say so) or `publisher` (the publisher's skills in `.agents/skills/`). */
  kind: "workspace" | "publisher";
  /** Dir holding `<skill>/SKILL.md` folders. */
  srcDir: string;
  /** Skill dir names to copy; omitted = every skill dir found. */
  allow?: string[];
  /**
   * Skill dir names that are LISTED (loadable through the Skill tool); omitted = every copied one. A copied but unlisted
   * skill stays on disk only because another skill's scripts reach into its dir (executing-plans calls the scripts of
   * subagent-driven-development by relative path).
   */
  expose?: string[];
  caps: PluginCaps;
  /** The real path of `srcDir` must sit inside this dir (a workspace dir must not escape its workspace). */
  trustRoot?: string;
}

/** A skill dir name the builder copies (also what a path-traversal name could never match). */
const SKILL_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** No skills, nothing to clean. */
export const NO_SKILLS: RunSkills = { skills: [], dirs: [], scriptDirs: [], cleanup: () => {} };

/** Concatenate the skills, plugins, dirs and cleanups of several plugins into one run's view. */
export function mergeRunSkills(parts: RunSkills[]): RunSkills {
  const plugins = parts.flatMap((p) => p.plugins ?? []);
  return {
    skills: parts.flatMap((p) => p.skills),
    ...(plugins.length && { plugins }),
    dirs: parts.flatMap((p) => p.dirs),
    scriptDirs: parts.flatMap((p) => p.scriptDirs),
    cleanup: () => {
      for (const p of parts) p.cleanup();
    },
  };
}

/**
 * Build ONE app-owned plugin: a fresh dir under `<agentHome>/tmp` holding ONLY an app-written manifest and a copy of
 * the skill dirs, whole (every regular file, exec bit kept): symlinks are skipped, no hooks/.mcp.json/agents/commands/
 * settings exist in it. Caps per skill (entries, bytes, one file's size; an
 * offending skill is skipped alone with a warn) and for the whole dir (over it, or on an IO error, nothing loads:
 * fail closed, warn). A missing/empty source is the normal case (debug log only). Never throws.
 * Logs `skills.plugin_built`. The caller runs `cleanup` in a `finally`.
 */
export function buildSkillsPlugin(spec: PluginSpec, agentHome: string): RunSkills {
  const { name, kind, srcDir, caps } = spec;
  const started = Date.now();
  let root: string | undefined;
  try {
    // A symlinked skills dir is refused outright: it could point at a repo's skills dir.
    if (lstatSync(srcDir).isSymbolicLink()) {
      log.warn({ [kind]: name }, `${kind} skills dir is a symlink: no skills loaded`);
      return NO_SKILLS;
    }
    const src = realpathSync(srcDir);
    if (spec.trustRoot && !src.startsWith(realpathSync(spec.trustRoot) + sep)) return NO_SKILLS;
    const base = join(agentHome, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(base, PLUGIN_PREFIX));
    const dir = root;
    mkdirSync(join(dir, ".claude-plugin"), { mode: 0o700 });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    const budget = { files: 0, bytes: 0 };
    const skills: string[] = [];
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (spec.allow && !spec.allow.includes(e.name)) continue;
      if (!SKILL_DIR_NAME.test(e.name)) continue; // a plain slug: never a path (traversal) or a dotfile
      const from = join(src, e.name);
      if (!lstatSync(from).isDirectory()) continue; // files and symlinks at the top are not skills
      if (!existsSync(join(from, "SKILL.md"))) {
        log.debug({ skill: `${name}:${e.name}` }, "skill dir without SKILL.md skipped");
        continue;
      }
      // Per-skill budget: an offending skill is dropped alone, the others still load.
      const to = join(dir, "skills", e.name);
      const one = { files: 1, bytes: 0, maxFiles: caps.skill.files, maxBytes: caps.skill.bytes }; // the skill dir itself counts
      try {
        copySkillTree(from, to, one, 1); // depth 1: the skill dir sits one level below skills/
      } catch (err) {
        removeTree(to);
        log.warn({ skill: `${name}:${e.name}`, reason: (err as Error).message }, "skill skipped");
        continue;
      }
      budget.files += one.files;
      budget.bytes += one.bytes;
      if (budget.files > caps.total.files || budget.bytes > caps.total.bytes) {
        throw new Error(`${kind} skills over the total cap at ${name}:${e.name}`);
      }
      // The SDK may key a skill by its frontmatter name; the allowlist must use the same key.
      const fm = frontmatterName(join(to, "SKILL.md"));
      if (fm && fm !== e.name) {
        log.debug({ dir: e.name, name: fm }, "skill frontmatter name differs from dir name");
      }
      if (!spec.expose || spec.expose.includes(e.name)) skills.push(`${name}:${fm ?? e.name}`);
    }
    if (!skills.length) {
      removeTree(dir);
      log.debug({ [kind]: name }, `${kind} has no skills`);
      return NO_SKILLS;
    }
    lockTree(dir); // read-only from here on (cleanup unlocks)
    const real = realpathSync(dir);
    logEvent(log, "skills.plugin_built", {
      [kind]: name,
      skills: skills.length,
      files: budget.files,
      bytes: budget.bytes,
      ms: Date.now() - started,
    });
    return {
      plugins: [{ type: "local" as const, path: real }],
      skills,
      dirs: [real],
      scriptDirs: kind === "publisher" ? [real] : [],
      cleanup: () => removeTree(real),
    };
  } catch (err) {
    if (root) removeTree(root);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug({ [kind]: name }, `${kind} has no skills dir`);
    } else {
      log.warn({ [kind]: name, err: String(err) }, `${kind} skills not loaded`);
    }
    return NO_SKILLS;
  }
}
