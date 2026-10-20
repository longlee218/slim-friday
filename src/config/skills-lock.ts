import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../observability/logger";

/** Child logger made on use (this module is imported while the logger module is still loading). */
const getLog = () => logger.child({ module: "skills-lock" });

/** The app's `skills-lock.json` (written by the `skills` CLI): one entry per installed publisher skill. */
export const SKILLS_LOCK_FILE = join(import.meta.dir, "../../skills-lock.json");

/** One lock entry: the skill dir name is the key; `source` is `<owner>/<pack>` of the publisher. */
export interface SkillsLockEntry {
  source: string;
}

/**
 * Pack names too generic to name a plugin: several publishers use them (`anthropics/skills`, `wshobson/agents`,
 * `addyosmani/agent-skills`, `vercel-labs/agent-skills`, `supabase/agent-skills`), so they would collide with each
 * other and with ordinary words in src and workspace names.
 */
const GENERIC_REPO_NAMES = new Set(["skills", "agents", "agent-skills"]);

/**
 * Plugin name of a lock entry (its skills load as `<plugin>:<skill>`): the last segment of its `source`
 * (`<owner>/<pack>` -> `<pack>`, `.git` dropped). A generic last segment takes its owner too (`<owner>/skills` ->
 * `<owner>-skills`). Existing names stay as they are, so installing a generic-named pack renames no loaded skill.
 */
export const pluginNameOf = (source: string): string => {
  const parts = source
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const pack = parts.at(-1) ?? "";
  const owner = parts.at(-2);
  return GENERIC_REPO_NAMES.has(pack) && owner ? `${owner}-${pack}` : pack;
};

/** A plugin name is a plain slug: it becomes `<plugin>:<skill>` and a workspace-name clash check. */
export const isPluginName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);

/**
 * Entries of the lock by skill dir name. Never throws: a missing lock = no installed skills (warn); a lock that exists but
 * cannot be read or parsed = no installed skills (warn with the reason); two entries whose `source` gives the same plugin
 * name from different sources are warned about once (their skills would share one plugin).
 */
export function readSkillsLock(file: string = SKILLS_LOCK_FILE): Record<string, SkillsLockEntry> {
  const log = getLog();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    log.warn({ file, reason: String(err) }, "skills lock not read: no publisher skills");
    return {};
  }
  const out: Record<string, SkillsLockEntry> = {};
  try {
    const parsed = JSON.parse(text) as { skills?: Record<string, { source?: unknown }> };
    for (const [name, e] of Object.entries(parsed.skills ?? {}))
      if (typeof e?.source === "string") out[name] = { source: e.source };
      else log.warn({ file, skill: name }, "skills lock entry has no source: skipped");
  } catch (err) {
    log.warn({ file, reason: String(err) }, "skills lock is not valid JSON: no publisher skills");
    return {};
  }
  const sourceOf = new Map<string, string>();
  for (const { source } of Object.values(out)) {
    const plugin = pluginNameOf(source);
    const seen = sourceOf.get(plugin);
    if (seen !== undefined && seen !== source)
      log.warn({ plugin, sources: [seen, source] }, "two skills sources give the same plugin name");
    sourceOf.set(plugin, seen ?? source);
  }
  return out;
}

/** Plugin names of the installed publishers (read once at startup: the lock only changes with a new install + restart). */
export const publisherPluginNames = (file?: string): string[] => [
  ...new Set(
    Object.values(readSkillsLock(file))
      .map((e) => pluginNameOf(e.source))
      .filter(isPluginName),
  ),
];
