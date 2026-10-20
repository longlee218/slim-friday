import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isPluginName,
  pluginNameOf,
  readSkillsLock,
  SKILLS_LOCK_FILE,
} from "../../config/skills-lock";
import { log, type PluginCaps } from "./plugin-copy";

/**
 * Where the publisher's skills live: `<app root>/.agents/skills/<name>/` (a flat dir of skill folders, pinned by the
 * location-root `skills-lock.json`). They are loaded whole and unmodified: Friday never patches a skill text.
 */
export const PUBLISHER_SKILLS_DIR = join(import.meta.dir, "../../../.agents/skills");

/**
 * Caps of the publisher plugin: per skill 100 entries / 4 MB, whole plugin 300 entries / 5 MB (one file: 2 MB, see
 * plugin-copy). 4 MB per skill: the owner's design skills carry data (CSV/JSON indexes up to 3.6 MB per skill).
 */
export const PUBLISHER_CAPS: PluginCaps = {
  skill: { files: 100, bytes: 4 * 1024 * 1024 },
  total: { files: 300, bytes: 5 * 1024 * 1024 },
};

/** The installed skills of one publisher: they load as one plugin `<plugin>:<skill>`. */
export interface PublisherPlugin {
  plugin: string;
  skills: string[];
}

/**
 * Installed publisher skills, from data only: the lock entries whose dir exists in `srcDir`, grouped by `source` (one
 * plugin per source, named by the source's last segment). An entry without a dir is warned about and left out; a dir
 * the lock does not list is never loaded. A new install (lock + dir) shows up with no code change.
 */
export function installedPublisherPlugins(
  srcDir: string = PUBLISHER_SKILLS_DIR,
  lockFile: string = SKILLS_LOCK_FILE,
): PublisherPlugin[] {
  const groups = new Map<string, string[]>();
  for (const [name, { source }] of Object.entries(readSkillsLock(lockFile))) {
    const plugin = pluginNameOf(source);
    if (!isPluginName(plugin)) {
      log.warn({ skill: name, source }, "lock entry has no usable plugin name: skipped");
      continue;
    }
    if (!existsSync(join(srcDir, name))) {
      log.warn({ skill: `${plugin}:${name}` }, "skill is in the lock but not on disk");
      continue;
    }
    groups.set(plugin, [...(groups.get(plugin) ?? []), name]);
  }
  return [...groups].map(([plugin, skills]) => ({ plugin, skills }));
}
