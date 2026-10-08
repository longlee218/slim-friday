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
import { logger } from "../observability/logger";
import type { ToolMode } from "../tools/tool-catalog";
import { listRepoSkills } from "./repo-skills";

/** Logger of this module. */
const log = logger.child({ module: "clone-skill-plugin" });

/** Caps on the copied skills (the clone's content is remote-controlled): file count and total bytes. */
const MAX_FILES = 300;
const MAX_BYTES = 5 * 1024 * 1024;

/** Skills + plugin options of one run, and the cleanup of the plugin dir the app created for it. */
export interface RunSkills {
  skills: string[];
  plugins?: NonNullable<Options["plugins"]>;
  /** Removes the app-owned plugin dir (no-op when none was created). */
  cleanup: () => void;
}

/** Plugin name = the workspace name reduced to a safe token (it prefixes the qualified skill names). */
const pluginName = (repo: string | undefined): string =>
  (repo ?? "repo").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "repo";

/**
 * Copy regular files/dirs of `src` to `dst`. Symlinks are skipped (their target may live anywhere), and the
 * walk stops with an error past the caps. `budget` is shared across the recursion.
 */
function copySkillTree(src: string, dst: string, budget: { files: number; bytes: number }): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    const st = lstatSync(from); // lstat: never follow
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      copySkillTree(from, to, budget);
    } else if (st.isFile()) {
      budget.files++;
      budget.bytes += st.size;
      if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) throw new Error("skills too large");
      copyFileSync(from, to);
    }
  }
}

/**
 * App-owned plugin for a `full` repo's exec stage: a fresh dir under `<agentHome>/tmp` holding ONLY an
 * app-written manifest and a copy of `<clone>/.claude/skills`. The clone's hooks, .mcp.json, agents,
 * commands and settings are never copied, so remote content cannot run code outside the guard.
 * Returns undefined when the clone has no (safe, small enough) skills.
 */
export function cloneSkillPlugin(
  clonePath: string,
  agentHome: string,
  repo?: string,
): RunSkills | undefined {
  let root: string | undefined;
  try {
    const skillsSrc = realpathSync(join(clonePath, ".claude", "skills"));
    // A symlinked .claude or skills dir that leaves the clone is refused outright.
    if (!skillsSrc.startsWith(realpathSync(clonePath) + sep)) return undefined;
    const base = join(agentHome, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(base, "plugin-"));
    const dir = root;
    const name = pluginName(repo);
    mkdirSync(join(dir, ".claude-plugin"), { mode: 0o700 });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    copySkillTree(skillsSrc, join(dir, "skills"), { files: 0, bytes: 0 });
    const names = readdirSync(join(dir, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md")))
      .map((e) => e.name);
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    if (!names.length) {
      cleanup();
      return undefined;
    }
    return {
      plugins: [{ type: "local", path: dir }],
      skills: names.map((n) => `${name}:${n}`),
      cleanup,
    };
  } catch (err) {
    // Missing skills dir is normal; anything else (caps, IO) fails closed: no skills, no plugin.
    if (root) rmSync(root, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ err: String(err) }, "clone skills not loaded");
    }
    return undefined;
  }
}

/**
 * Skills option of a run. Plan/Q&A load project settings, so list the repos' own skills. Exec loads no
 * settings (the worktree is agent-writable): none, or for a `full` repo the app-owned copy of the clone's skills.
 */
export function runSkills(
  mode: ToolMode,
  o: {
    cwd: string;
    additionalDirectories?: string[];
    skillsFromClone?: string;
    /** Workspace name: names the plugin. */
    logRepo?: string;
  },
  agentHome: string,
): RunSkills {
  if (mode !== "exec") {
    return {
      skills: listRepoSkills([o.cwd, ...(o.additionalDirectories ?? [])]),
      cleanup: () => {},
    };
  }
  const plugin = o.skillsFromClone
    ? cloneSkillPlugin(o.skillsFromClone, agentHome, o.logRepo)
    : undefined;
  return plugin ?? { skills: [], cleanup: () => {} };
}
